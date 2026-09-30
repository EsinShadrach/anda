// Keeps a <video> on the room's clock. The server is the source of truth; this follows it,
// gently, because every playbackRate change makes the browser restart its pitch-corrected
// audio (a stream of small changes is heard as choppy sound):
//   - the drift is smoothed (median of the last few ticks), so clock and network jitter
//     aren't mistaken for drift
//   - within 0.2s: leave it alone, at exactly 1x
//   - past that: correct at a fixed 1.04x / 0.96x (1.1x if over a second behind) until
//     within 0.03s, then back to 1x: two rate changes per correction, not a wobble
//   - ahead by over 1.5s or behind by over 4s: hard seek
// Echo loops: a player event counts as a user action only if it disagrees with the room
// (so our own play()/pause()/seeks, which always agree, are ignored). That also catches
// keyboard shortcuts, media keys and the iOS native fullscreen player.

import type { RoomConnection, RoomView } from "./room";

export type PlayerState = {
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  waiting: boolean;
  needsTap: boolean; // the browser blocked unmuted autoplay; one tap unlocks it
  volume: number;
  muted: boolean;
};

const TICK_MS = 250;
const DRIFT_SAMPLES = 5; // median over ~1.25s
const START_CORRECTING = 0.2; // seconds off before we touch the rate
const STOP_CORRECTING = 0.03;
const SEEK_AHEAD = 1.5; // slowing down from further ahead would take too long
const SEEK_BEHIND = 4;
const REPORT_MS = 2000;
const SEEK_TOLERANCE = 1; // a player seek within this of the room is ours, not the user's

export class PlayerSync {
  private video: HTMLVideoElement | null = null;
  private conn: RoomConnection;
  private tick: ReturnType<typeof setInterval> | undefined;
  private lastReport = 0;
  private lastStalling = false;
  private waitingSince = 0;
  private drifts: number[] = [];
  private correcting = false;
  private unlocked = false;
  private unlocking = false; // our own play() from the unlock tap is not a user action

  // Our own play()/pause()/seeks fire events asynchronously; by the time they arrive the
  // room may already have moved on, so "does it disagree with the room?" alone would
  // misread them as user actions. Remember what we did and ignore its echo.
  private selfPlayAt = 0;
  private selfPauseAt = 0;
  private selfSeek = { target: -1, at: 0 };
  private listeners = new Set<() => void>();
  private duckFactor = 1; // < 1 while someone on voice is talking
  private duckTimer: ReturnType<typeof setInterval> | undefined;
  private applyingDuck = false;
  private detachVideo: (() => void) | null = null;
  private state: PlayerState = {
    currentTime: 0,
    duration: 0,
    bufferedEnd: 0,
    waiting: false,
    needsTap: true,
    volume: 1,
    muted: false,
  };

  constructor(conn: RoomConnection) {
    this.conn = conn;
    try {
      const v = Number(localStorage.getItem("anda.volume"));
      if (v >= 0 && v <= 1 && localStorage.getItem("anda.volume") !== null) this.state.volume = v;
      this.state.muted = localStorage.getItem("anda.muted") === "1";
    } catch {
      // storage blocked: defaults are fine
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  attach(video: HTMLVideoElement) {
    this.detach();
    this.video = video;
    video.volume = this.state.volume * this.duckFactor;
    video.muted = this.state.muted;
    const on = <K extends keyof HTMLVideoElementEventMap>(type: K, fn: () => void) => {
      video.addEventListener(type, fn);
      return () => video.removeEventListener(type, fn);
    };
    const offs = [
      on("play", this.onPlay),
      on("pause", this.onPause),
      on("seeking", this.onSeeking),
      on("waiting", () => {
        this.waitingSince ||= Date.now();
        this.patch({ waiting: true });
        this.report(true);
      }),
      on("playing", () => {
        this.waitingSince = 0;
        this.patch({ waiting: false });
        this.report(true);
      }),
      on("canplay", () => this.report(true)),
      on("loadedmetadata", () => this.patch({ duration: video.duration || 0 })),
      on("timeupdate", this.readTime),
      on("progress", this.readTime),
      on("volumechange", () => {
        // Our own ducking isn't the user changing the volume.
        if (this.applyingDuck) this.patch({ muted: video.muted });
        else this.patch({ volume: video.volume / this.duckFactor, muted: video.muted });
      }),
    ];
    this.detachVideo = () => offs.forEach((off) => off());
    this.tick = setInterval(this.reconcile, TICK_MS);
    this.reconcile();
  }

  detach() {
    clearInterval(this.tick);
    clearInterval(this.duckTimer);
    this.detachVideo?.();
    this.detachVideo = null;
    this.video = null;
  }

  /** Rejoin after being away: lift the gate and, from this tap, allow sound again. */
  rejoin() {
    this.conn.stillHere();
    return this.unlock();
  }

  /** Called from a tap: lets the browser play sound, then hands control back to the room. */
  async unlock() {
    const v = this.video;
    if (!v) return;
    this.unlocking = true;
    try {
      await v.play();
      this.unlocked = true;
      this.patch({ needsTap: false });
    } catch {
      return;
    } finally {
      // Hand straight back to the room: this pauses again if the room is paused.
      this.reconcile();
      this.unlocking = false;
    }
  }

  setVolume(volume: number) {
    const v = this.video;
    if (!v) return;
    volume = Math.min(1, Math.max(0, volume));
    this.patch({ volume });
    this.applyingDuck = true;
    v.volume = volume * this.duckFactor;
    v.muted = volume === 0;
    this.applyingDuck = false;
    this.persist();
  }

  /**
   * Lower the film while someone on voice talks (plan: "lower movie volume while someone
   * speaks"), easing over ~250ms down and ~600ms back up so it doesn't pump.
   */
  duck(on: boolean) {
    const target = on ? 0.3 : 1;
    clearInterval(this.duckTimer);
    const step = on ? 0.14 : 0.06;
    this.duckTimer = setInterval(() => {
      const d = target - this.duckFactor;
      this.duckFactor = Math.abs(d) <= step ? target : this.duckFactor + Math.sign(d) * step;
      const v = this.video;
      if (v) {
        this.applyingDuck = true;
        v.volume = this.state.volume * this.duckFactor;
        this.applyingDuck = false;
      }
      if (this.duckFactor === target) clearInterval(this.duckTimer);
    }, 40);
  }

  toggleMute() {
    const v = this.video;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.6;
    this.persist();
  }

  // --- the loop ---

  private reconcile = () => {
    const v = this.video;
    const view = this.conn.getSnapshot();
    if (!v || !view.media || !view.playback) return;

    const { target, running } = this.desired(view);

    if (running && this.unlocked) {
      if (v.paused) {
        this.selfPlayAt = Date.now();
        v.play().catch(this.onBlocked);
      }
      this.drifts.push(v.currentTime - target);
      if (this.drifts.length > DRIFT_SAMPLES) this.drifts.shift();
      const drift = median(this.drifts);
      if (drift < -SEEK_BEHIND || drift > SEEK_AHEAD) {
        this.seekTo(v, target);
        this.setRate(v, 1);
        this.correcting = false;
      } else {
        if (!this.correcting && Math.abs(drift) > START_CORRECTING) this.correcting = true;
        else if (this.correcting && Math.abs(drift) < STOP_CORRECTING) this.correcting = false;
        this.setRate(v, !this.correcting ? 1 : drift > 0 ? 0.96 : drift < -1 ? 1.1 : 1.04);
      }
    } else {
      this.drifts = []; // a fresh measurement when it runs again
      this.correcting = false;
      if (!v.paused) {
        this.selfPauseAt = Date.now();
        v.pause();
      }
      this.setRate(v, 1);
      if (Math.abs(v.currentTime - target) > 0.1 && !v.seeking) this.seekTo(v, target); // paused: show the same frame
    }

    // Report promptly while the room is waiting on us; otherwise every couple of seconds.
    const waitingOnMe = view.blockers.some((b) => b.user_id === view.me);
    if (waitingOnMe || Date.now() - this.lastReport > REPORT_MS) this.report(false);
  };

  private seekTo(v: HTMLVideoElement, target: number) {
    this.selfSeek = { target, at: Date.now() };
    this.drifts = []; // the old samples describe where we were, not where we are
    v.currentTime = target;
  }

  // Only touch playbackRate when it actually changes.
  private setRate(v: HTMLVideoElement, rate: number) {
    if (v.playbackRate !== rate) v.playbackRate = rate;
  }

  /** What the room (or our pending intent) says the video should be doing. */
  private desired(view: RoomView): { target: number; running: boolean } {
    const p = view.playback!;
    let target = this.conn.targetPosition();
    let running = p.want === "playing" && view.blockers.length === 0 && !view.gate;
    const i = view.intent;
    if (i && Date.now() - i.at < 2000) {
      // Pause and seek feel instant locally; play waits for everyone to get ready.
      if (i.want === "paused") running = false;
      if (i.position !== undefined) target = i.position;
    }
    return { target, running };
  }

  private report(force: boolean) {
    const v = this.video;
    const view = this.conn.getSnapshot();
    if (!v || !view.media || !view.playback) return;
    const now = Date.now();
    const wantRunning = view.playback.want === "playing";
    const stalling = wantRunning && this.waitingSince > 0 && now - this.waitingSince > 250;
    if (!force && now - this.lastReport < 400 && stalling === this.lastStalling) return;
    this.lastReport = now;
    this.lastStalling = stalling;
    this.conn.bufferReport(this.ahead(v), stalling);
  }

  // --- echo-loop rule: only disagreements are user actions ---

  private onPlay = () => {
    const view = this.conn.getSnapshot();
    if (!view.playback || this.unlocking || Date.now() - this.selfPlayAt < 1000) return;
    if (view.gate) {
      // Pressing play (e.g. in the native iOS player) while held back means "I'm back".
      this.conn.stillHere();
      return;
    }
    const wanted = view.intent?.want ?? view.playback.want;
    if (wanted !== "playing") this.conn.play();
  };

  private onPause = () => {
    const v = this.video;
    const view = this.conn.getSnapshot();
    // A hidden page's video is paused by the browser (tab switch, phone locked), not by a
    // person: that makes this viewer away, it doesn't pause the room for everyone.
    if (!v || !view.playback || v.ended || this.unlocking || view.gate || document.visibilityState === "hidden") return;
    if (Date.now() - this.selfPauseAt < 1000) return; // ours
    if (this.desired(view).running) this.conn.pause();
  };

  private onSeeking = () => {
    const v = this.video;
    const view = this.conn.getSnapshot();
    if (!v || !view.playback || view.gate) return;
    const ours = Math.abs(v.currentTime - this.selfSeek.target) < 0.5 && Date.now() - this.selfSeek.at < 2000;
    if (ours) return;
    if (Math.abs(v.currentTime - this.desired(view).target) > SEEK_TOLERANCE) this.conn.seek(v.currentTime);
  };

  private onBlocked = (err: unknown) => {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      this.unlocked = false;
      this.patch({ needsTap: true });
    }
  };

  private readTime = () => {
    const v = this.video;
    if (!v) return;
    let bufferedEnd = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5) bufferedEnd = Math.max(bufferedEnd, v.buffered.end(i));
    }
    this.patch({ currentTime: v.currentTime, duration: v.duration || this.state.duration, bufferedEnd });
  };

  private ahead(v: HTMLVideoElement) {
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.1 && v.currentTime <= v.buffered.end(i)) {
        return v.buffered.end(i) - v.currentTime;
      }
    }
    return 0;
  }

  private persist() {
    try {
      localStorage.setItem("anda.volume", String(this.state.volume));
      localStorage.setItem("anda.muted", this.video?.muted ? "1" : "0");
    } catch {
      // storage blocked
    }
  }

  private patch(p: Partial<PlayerState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn());
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
