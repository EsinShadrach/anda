// Voice and camera through LiveKit (plan, step 7). The server only hands out a token for the
// room we're in; audio and video go browser <-> LiveKit directly. livekit-client is large, so
// it's loaded on first use. The session connects receive-only when the room opens, so we hear
// people straight away; the mic and camera are published only when turned on.

import type { Participant, RemoteTrackPublication, Room, Track } from "livekit-client";

export type VoicePeer = {
  id: number; // Anda user ID (the LiveKit identity)
  name: string;
  self: boolean;
  micOn: boolean;
  camOn: boolean;
  speaking: boolean;
  quality: "good" | "fair" | "poor" | "unknown";
  video: Track | null; // camera track to attach, when on and subscribed
};

export type VoiceStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unavailable" // voice isn't set up on this server
  | "failed"; // couldn't reach LiveKit (network or firewall)

export type VoiceState = {
  status: VoiceStatus;
  peers: VoicePeer[]; // everyone publishing mic or camera, self included
  micOn: boolean;
  camOn: boolean;
  pushToTalk: boolean; // mic is on only while held
  othersSpeaking: boolean; // someone else is talking: the film ducks
  needsAudioTap: boolean; // browser blocked autoplay of voices until a gesture
  notice: { id: number; text: string } | null;
};

const QUALITY: Record<string, VoicePeer["quality"]> = { excellent: "good", good: "good", poor: "fair", lost: "poor" };

export class VoiceSession {
  private code: string;
  private room: Room | null = null;
  private lk: typeof import("livekit-client") | null = null;
  private listeners = new Set<() => void>();
  private audioEls = new Map<string, HTMLMediaElement>();
  private noticeSeq = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private remoteVideoPaused = false; // our own link is struggling: incoming cameras are off
  private busy = false;
  private headphonesHinted = false;
  private state: VoiceState = {
    status: "idle",
    peers: [],
    micOn: false,
    camOn: false,
    pushToTalk: false,
    othersSpeaking: false,
    needsAudioTap: false,
    notice: null,
  };

  constructor(code: string) {
    this.code = code;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  async start() {
    this.stopped = false;
    if (process.env.NODE_ENV === "development") (window as unknown as { __voice: VoiceSession }).__voice = this;
    if (this.room || this.state.status === "connecting") return;
    this.patch({ status: "connecting" });
    let url: string, token: string;
    try {
      const res = await fetch(`/api/rooms/${this.code}/voice`, { method: "POST" });
      if (res.status === 503) return this.patch({ status: "unavailable" });
      if (!res.ok) throw new Error(`voice token: ${res.status}`);
      ({ url, token } = await res.json());
    } catch {
      return this.retryLater();
    }
    if (this.stopped) return;

    const lk = (this.lk ??= await import("livekit-client"));
    const room = new lk.Room({
      adaptiveStream: true, // subscribe to the camera size a tile actually shows
      dynacast: true, // don't send layers nobody is watching
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      videoCaptureDefaults: { resolution: lk.VideoPresets.h360.resolution, facingMode: "user" },
      // Simulcast: weak viewers get a low layer. Audio is Opus with DTX and RED for loss.
      publishDefaults: { simulcast: true, videoSimulcastLayers: [lk.VideoPresets.h180], dtx: true, red: true },
    });
    this.wire(room, lk);
    try {
      await room.connect(url, token, { autoSubscribe: true });
    } catch {
      room.removeAllListeners();
      return this.retryLater();
    }
    if (this.stopped) {
      room.disconnect();
      return;
    }
    this.room = room;
    this.attempts = 0;
    this.patch({ status: "connected", needsAudioTap: !room.canPlaybackAudio });
    this.refresh();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.noticeTimer);
    clearTimeout(this.poorTimer);
    clearTimeout(this.recoverTimer);
    this.room?.disconnect();
    this.room = null;
    this.audioEls.forEach((el) => el.remove());
    this.audioEls.clear();
  }

  /** Call from a tap: lets the browser play voices. */
  unlockAudio() {
    this.room?.startAudio().then(() => this.patch({ needsAudioTap: false }), () => {});
  }

  async toggleMic() {
    if (this.state.pushToTalk) {
      this.patch({ pushToTalk: false });
      return this.setMic(false);
    }
    await this.setMic(!this.state.micOn);
  }

  /** Push-to-talk: the mic is live only while held. */
  async holdToTalk(down: boolean) {
    if (down === this.state.pushToTalk) return;
    if (down && this.state.micOn) return; // already talking normally
    this.patch({ pushToTalk: down });
    await this.setMic(down);
  }

  async toggleCamera() {
    const room = await this.ready();
    if (!room || this.busy) return;
    this.busy = true;
    try {
      // A request that never settles (e.g. a stalled device prompt) mustn't lock the button.
      await Promise.race([
        room.localParticipant.setCameraEnabled(!this.state.camOn),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
      ]);
    } catch (e) {
      this.flash(deviceError(e, "camera"));
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private async setMic(on: boolean) {
    const room = await this.ready();
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(on);
      if (on && !this.headphonesHinted) {
        this.headphonesHinted = true;
        this.flash("Headphones keep the film from echoing into your mic");
      }
    } catch (e) {
      this.patch({ pushToTalk: false });
      this.flash(deviceError(e, "microphone"));
    }
    this.refresh();
  }

  private async ready(): Promise<Room | null> {
    if (this.room) return this.room;
    if (this.state.status === "unavailable") return null;
    if (this.state.status === "failed" || this.state.status === "idle") await this.start();
    if (!this.room) this.flash("Voice can’t connect right now");
    return this.room;
  }

  private retryLater() {
    if (this.stopped) return;
    this.patch({ status: "failed" });
    // Back off: 5s, 10s, 20s ... up to 2 minutes. The buttons still work; they retry now.
    const delay = Math.min(120_000, 5000 * 2 ** this.attempts++);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), delay);
  }

  private wire(room: Room, lk: typeof import("livekit-client")) {
    const E = lk.RoomEvent;
    const refresh = () => this.refresh();
    room
      .on(E.ParticipantConnected, refresh)
      .on(E.ParticipantDisconnected, refresh)
      .on(E.TrackPublished, refresh)
      .on(E.TrackUnpublished, refresh)
      .on(E.TrackMuted, refresh)
      .on(E.TrackUnmuted, refresh)
      .on(E.LocalTrackPublished, refresh)
      .on(E.LocalTrackUnpublished, refresh)
      .on(E.ActiveSpeakersChanged, refresh)
      .on(E.TrackSubscribed, (track, pub) => {
        if (track.kind === lk.Track.Kind.Audio) {
          const el = track.attach();
          el.style.display = "none";
          document.body.appendChild(el);
          this.audioEls.set(pub.trackSid, el);
        }
        this.refresh();
      })
      .on(E.TrackUnsubscribed, (track, pub) => {
        track.detach().forEach((el) => el.remove());
        this.audioEls.delete(pub.trackSid);
        this.refresh();
      })
      .on(E.ConnectionQualityChanged, (quality, p) => {
        if (p.isLocal) this.onLocalQuality(quality, lk);
        this.refresh();
      })
      .on(E.AudioPlaybackStatusChanged, () => this.patch({ needsAudioTap: !room.canPlaybackAudio }))
      .on(E.Reconnecting, () => this.patch({ status: "reconnecting" }))
      .on(E.Reconnected, () => this.patch({ status: "connected" }))
      .on(E.Disconnected, () => {
        if (this.room !== room) return;
        this.room = null;
        this.audioEls.forEach((el) => el.remove());
        this.audioEls.clear();
        this.patch({ micOn: false, camOn: false, pushToTalk: false, peers: [], othersSpeaking: false });
        this.retryLater();
      });
  }

  // Plan: "incoming cameras auto-disable on a struggling connection", and our own camera
  // too, so voice (which has priority) keeps working. LiveKit's "poor" also reflects a
  // video's bitrate (a still, dark scene can score low), so it takes 20s of poor, or 5s of
  // lost, before acting; incoming cameras come back after 15s of good.
  private poorTimer: ReturnType<typeof setTimeout> | undefined;
  private lostTimer = false; // the pending timer is the shorter "lost" one
  private recoverTimer: ReturnType<typeof setTimeout> | undefined;
  private onLocalQuality(q: string, lk: typeof import("livekit-client")) {
    const lost = q === lk.ConnectionQuality.Lost;
    if (lost || q === lk.ConnectionQuality.Poor) {
      clearTimeout(this.recoverTimer);
      this.recoverTimer = undefined;
      // Start the wait, or switch to the shorter one when poor becomes lost.
      if (!this.poorTimer || (lost && !this.lostTimer)) {
        clearTimeout(this.poorTimer);
        this.lostTimer = lost;
        this.poorTimer = setTimeout(() => this.struggling(), lost ? 5000 : 20_000);
      }
      return;
    }
    clearTimeout(this.poorTimer);
    this.poorTimer = undefined;
    this.lostTimer = false;
    // Quality is only reported when it changes, so recovery is a timer, not a later event.
    if (this.remoteVideoPaused && !this.recoverTimer) {
      this.recoverTimer = setTimeout(() => {
        this.recoverTimer = undefined;
        this.remoteVideoPaused = false;
        this.forRemoteVideo((pub) => pub.setEnabled(true));
        this.refresh();
      }, 15_000);
    }
  }

  private struggling() {
    this.poorTimer = undefined;
    this.lostTimer = false;
    const room = this.room;
    if (!room) return;
    if (this.state.camOn) {
      room.localParticipant.setCameraEnabled(false).then(() => this.refresh());
      this.flash("Your camera turned off to keep voice going on a weak connection");
    }
    if (!this.remoteVideoPaused) {
      this.remoteVideoPaused = true;
      this.forRemoteVideo((pub) => pub.setEnabled(false));
      this.refresh();
    }
  }

  private forRemoteVideo(fn: (pub: RemoteTrackPublication) => void) {
    this.room?.remoteParticipants.forEach((p) =>
      p.videoTrackPublications.forEach((pub) => fn(pub as RemoteTrackPublication)),
    );
  }

  private refresh() {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return;
    const local = room.localParticipant;
    const all: Participant[] = [local, ...room.remoteParticipants.values()];
    const peers: VoicePeer[] = [];
    for (const p of all) {
      const mic = p.getTrackPublication(lk.Track.Source.Microphone);
      const cam = p.getTrackPublication(lk.Track.Source.Camera);
      const micOn = !!mic && !mic.isMuted;
      const camOn = !!cam && !cam.isMuted && (p.isLocal || !this.remoteVideoPaused);
      if (!micOn && !camOn) continue; // only people actually on voice or camera get a tile
      peers.push({
        id: Number(p.identity),
        name: p.name || p.identity,
        self: p.isLocal,
        micOn,
        camOn,
        speaking: p.isSpeaking,
        quality: QUALITY[p.connectionQuality] ?? "unknown",
        video: camOn ? (cam?.track ?? null) : null,
      });
    }
    const micPub = local.getTrackPublication(lk.Track.Source.Microphone);
    const camPub = local.getTrackPublication(lk.Track.Source.Camera);
    this.patch({
      peers,
      micOn: !!micPub && !micPub.isMuted && !this.state.pushToTalk,
      camOn: !!camPub && !camPub.isMuted,
      othersSpeaking: peers.some((p) => !p.self && p.speaking),
    });
  }

  private flash(text: string) {
    clearTimeout(this.noticeTimer);
    this.patch({ notice: { id: ++this.noticeSeq, text } });
    this.noticeTimer = setTimeout(() => this.patch({ notice: null }), 3200);
  }

  private patch(p: Partial<VoiceState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn());
  }
}

function deviceError(e: unknown, what: "microphone" | "camera"): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") return `Allow the ${what} in your browser to use it here`;
  if (name === "NotFoundError") return `No ${what} found`;
  if (name === "NotReadableError") return `Your ${what} is in use by another app`;
  return `Couldn’t start the ${what}`;
}
