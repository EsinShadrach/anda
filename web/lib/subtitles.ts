// Subtitles on the room's <video>: WebVTT loaded into one text track we own, so a file can
// be swapped, re-timed (the +/- nudge for releases that don't line up), and reloaded while
// a film is still downloading (its subtitles grow with it). Styling is ::cue in globals.css.

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
  private line = 90; // % down the video element where the cue's bottom sits

  constructor(video: HTMLVideoElement) {
    // Reuse ours if this <video> already has it (the element outlives film changes).
    const existing = Array.from(video.textTracks).find((t) => t.label === "anda");
    this.track = existing ?? video.addTextTrack("subtitles", "anda");
    this.track.mode = "hidden";
  }

  /** Show url (null = off). growing: re-fetch now and then, the film is still arriving. */
  async show(url: string | null, growing: boolean) {
    clearInterval(this.timer);
    this.url = url;
    const seq = ++this.seq;
    if (!url) {
      this.cues = [];
      this.render();
      this.track.mode = "hidden";
      return;
    }
    await this.load(url, seq);
    this.track.mode = "showing";
    if (growing) this.timer = setInterval(() => this.url && this.load(this.url, this.seq), 30_000);
  }

  setOffset(seconds: number) {
    this.offset = seconds;
    this.render();
  }

  /** Where cues sit, as % from the top: raised above the player's controls while they show. */
  setLine(percent: number) {
    if (Math.abs(percent - this.line) < 0.5) return;
    this.line = percent;
    this.render(); // browsers don't re-lay-out a showing cue whose line changes; rebuild them
  }

  dispose() {
    clearInterval(this.timer);
    this.seq++;
    this.cues = [];
    this.render();
    this.track.mode = "hidden";
  }

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
      const cue = new VTTCue(Math.max(0, start), c.end + this.offset, c.text);
      cue.snapToLines = false;
      cue.line = this.line;
      cue.lineAlign = "end";
      t.addCue(cue);
    }
  }
}
