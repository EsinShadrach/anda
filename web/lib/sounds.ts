// Room sounds, synthesised with Web Audio (nothing to download): someone joined, someone
// left, a message, someone started typing. Soft, short and warm, pitched to sit under a
// film's dialogue rather than over it. Others' actions only; never our own.
//
// Browsers only let audio start after a gesture, so the context is created on the first
// tap or key press in the room. Until then sounds are skipped, not queued (a burst of old
// chimes on the first click would be worse than silence).

import type { RoomEvent } from "./room";

export type SoundKind = RoomEvent["kind"];

const KEY = "anda.sounds";

type Note = {
  freq: number;
  at?: number; // seconds after the sound starts
  dur: number; // to silence
  gain: number;
  glideTo?: number; // a quick slide, for the message "pop"
  type?: OscillatorType;
};

// Pitches from E major pentatonic, so any two sounds that overlap still agree.
const SOUNDS: Record<SoundKind, Note[]> = {
  // Two notes up: someone sat down.
  joined: [
    { freq: 659.25, dur: 0.34, gain: 0.16 },
    { freq: 1318.5, dur: 0.2, gain: 0.025 },
    { freq: 987.77, at: 0.095, dur: 0.48, gain: 0.15 },
    { freq: 1975.5, at: 0.095, dur: 0.24, gain: 0.02 },
  ],
  // Two notes down, quieter: someone left.
  left: [
    { freq: 830.61, dur: 0.3, gain: 0.11 },
    { freq: 554.37, at: 0.11, dur: 0.42, gain: 0.1 },
  ],
  // A rounded pop that lifts at the end, like a bubble.
  message: [
    { freq: 587.33, glideTo: 880, dur: 0.16, gain: 0.17 },
    { freq: 1760, at: 0.012, dur: 0.07, gain: 0.018 },
  ],
  // Two faint taps, barely there.
  typing: [
    { freq: 1661.2, dur: 0.035, gain: 0.025, type: "triangle" },
    { freq: 1661.2, at: 0.085, dur: 0.035, gain: 0.02, type: "triangle" },
  ],
};

// The same sound again sooner than this is dropped: a flurry of messages is one pop.
const SPACING: Record<SoundKind, number> = { joined: 600, left: 600, message: 350, typing: 4000 };

class RoomSounds {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private last: Partial<Record<SoundKind, number>> = {};
  private listeners = new Set<() => void>();
  private on = typeof window === "undefined" ? true : readOn();

  /** Call from a gesture: creates (or wakes) the audio context. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      // Everything goes through one gentle low-pass: no harsh edges on laptop speakers.
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 5000;
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.9;
      this.out.connect(lp).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  play(kind: SoundKind) {
    const ctx = this.ctx;
    if (!this.on || !ctx || !this.out || ctx.state !== "running") return;
    const now = performance.now();
    if (now - (this.last[kind] ?? 0) < SPACING[kind]) return;
    this.last[kind] = now;
    const t0 = ctx.currentTime + 0.01;
    for (const n of SOUNDS[kind]) this.note(ctx, this.out, n, t0 + (n.at ?? 0));
  }

  private note(ctx: AudioContext, out: AudioNode, n: Note, t: number) {
    const osc = ctx.createOscillator();
    osc.type = n.type ?? "sine";
    osc.frequency.setValueAtTime(n.freq, t);
    if (n.glideTo) osc.frequency.exponentialRampToValueAtTime(n.glideTo, t + n.dur * 0.45);
    const g = ctx.createGain();
    // A 6ms attack (no click), then an exponential fall: struck, not switched on.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(n.gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }

  // --- The on/off preference, remembered on this device --------------------------------

  get enabled() {
    return this.on;
  }

  setEnabled(on: boolean) {
    this.on = on;
    try {
      if (on) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, "off");
    } catch {
      // storage blocked: it just won't be remembered
    }
    this.listeners.forEach((fn) => fn());
    if (on) {
      this.unlock();
      this.last.message = 0;
      this.play("message"); // so you hear what you turned on
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.on;
}

function readOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export const sounds = new RoomSounds();
