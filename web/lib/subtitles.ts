// Subtitles on the room's <video>: WebVTT loaded into one text track we own, so a file can
// be swapped, re-timed (the +/- nudge for releases that don't line up), and reloaded while
// a film is still downloading (its subtitles grow with it).
//
// The track only keeps time ("hidden": the browser tracks which cues are active but draws
// nothing); the player draws the text itself, above its controls, sliding up and down with
// them. Native cue rendering put subtitles behind the control bar, and re-laying out a cue
// that's on screen made Safari drop it until the next one. The exception is the iPhone's own
// full-screen player, where ours can't draw: the track is "showing" there.

type Cue = { start: number; end: number; text: string };

const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/;

function seconds(t: string): number | null {
  const m = TIME.exec(t.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

export function parseVTT(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, rest = ""] = lines[at].split("-->");
    const start = seconds(a);
    const end = seconds(rest.trim().split(/\s+/)[0]); // drop cue settings
    const body = lines.slice(at + 1).join("\n").trim();
    if (start === null || end === null || !body) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}

export class SubtitleTrack {
  private track: TextTrack;
  private cues: Cue[] = [];
  private url: string | null = null;
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;
  private on = false; // a file is chosen
  private native = false; // the iPhone's own full-screen player is up
  private listeners = new Set<(cues: VTTCue[]) => void>();

  constructor(private video: HTMLVideoElement) {
    // Reuse ours if this <video> already has it (the element outlives film changes).
    const existing = Array.from(video.textTracks).find((t) => t.label === "anda");
    this.track = existing ?? video.addTextTrack("subtitles", "anda");
    this.track.mode = "hidden";
    this.track.addEventListener("cuechange", this.emit);
    video.addEventListener("seeked", this.emit);
    video.addEventListener("webkitbeginfullscreen", this.nativeOn);
    video.addEventListener("webkitendfullscreen", this.nativeOff);
  }

  /** The cues on screen now, whenever that changes. Returns an unsubscribe. */
  onCues(fn: (cues: VTTCue[]) => void) {
    this.listeners.add(fn);
    fn(this.active());
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Show url (null = off). growing: re-fetch now and then, the film is still arriving. */
  async show(url: string | null, growing: boolean) {
    clearInterval(this.timer);
    this.url = url;
    this.on = !!url;
    const seq = ++this.seq;
    if (!url) {
      this.cues = [];
      this.render();
      return;
    }
    await this.load(url, seq);
    if (growing) this.timer = setInterval(() => this.url && this.load(this.url, this.seq), 30_000);
  }

  setOffset(seconds: number) {
    this.offset = seconds;
    this.render();
  }

  dispose() {
    clearInterval(this.timer);
    this.seq++;
    this.cues = [];
    this.on = false;
    this.render();
    this.track.removeEventListener("cuechange", this.emit);
    this.video.removeEventListener("seeked", this.emit);
    this.video.removeEventListener("webkitbeginfullscreen", this.nativeOn);
    this.video.removeEventListener("webkitendfullscreen", this.nativeOff);
    this.listeners.clear();
  }

  private nativeOn = () => {
    this.native = true;
    this.track.mode = "showing";
  };

  private nativeOff = () => {
    this.native = false;
    this.track.mode = "hidden";
    this.emit();
  };

  private active(): VTTCue[] {
    if (!this.on) return [];
    return Array.from(this.track.activeCues ?? []).filter((c): c is VTTCue => c instanceof VTTCue);
  }

  private emit = () => {
    const cues = this.native ? [] : this.active();
    this.listeners.forEach((fn) => fn(cues));
  };

  private async load(url: string, seq: number) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const cues = parseVTT(await res.text());
      if (seq !== this.seq) return; // switched meanwhile
      this.cues = cues;
      this.render();
    } catch {
      // Keep what we have; a growing file is retried on the next tick.
    }
  }

  private render() {
    const t = this.track;
    for (const c of Array.from(t.cues ?? [])) t.removeCue(c);
    for (const c of this.cues) {
      const start = c.start + this.offset;
      if (c.end + this.offset <= 0) continue;
      t.addCue(new VTTCue(Math.max(0, start), c.end + this.offset, c.text));
    }
    // Swapping cues under a playing film doesn't always fire cuechange: say what's on now.
    setTimeout(this.emit, 0);
  }
}
