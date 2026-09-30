import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MicrophoneIcon, MicrophoneSlashIcon, VideoCameraIcon, VideoCameraSlashIcon, WarningIcon } from "@phosphor-icons/react";
import type { Track } from "livekit-client";
import type { VoicePeer, VoiceSession, VoiceState } from "@/lib/voice";
import { Avatar } from "@/components/ui/avatar";

const HOLD_MS = 280; // press longer than this on the mic = push-to-talk

// Mic and camera, in the header. Tap the mic to toggle; press and hold it to talk only
// while held (push-to-talk). Hidden when the server has no voice.
export function VoiceButtons({ voice, state }: { voice: VoiceSession; state: VoiceState }) {
  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; held: boolean }>({ held: false });
  if (state.status === "unavailable") return null;

  const failed = state.status === "failed";
  const talking = state.micOn || state.pushToTalk;
  const selfSpeaking = state.peers.some((p) => p.self && p.speaking);

  const endHold = () => {
    clearTimeout(hold.current.timer);
    if (hold.current.held) voice.holdToTalk(false);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          hold.current.held = false;
          hold.current.timer = setTimeout(() => {
            hold.current.held = true;
            voice.holdToTalk(true);
          }, HOLD_MS);
        }}
        onPointerUp={endHold}
        onPointerCancel={endHold}
        onPointerLeave={endHold}
        onClick={() => {
          if (hold.current.held) hold.current.held = false; // that was a hold, not a tap
          else voice.toggleMic();
        }}
        onContextMenu={(e) => e.preventDefault()} // long-press on phones is push-to-talk
        aria-pressed={talking}
        aria-label={talking ? "Mute microphone" : "Turn on microphone (hold to talk)"}
        title={failed ? "Voice can’t connect right now" : talking ? "Mute microphone" : "Mic off · tap to turn on, or hold (or hold T) to talk"}
        className={`press relative grid size-11 shrink-0 place-items-center rounded-2xl select-none transition-colors duration-150 ${
          talking ? "bg-ember-500 text-ink-950" : "glass text-fog-100"
        } ${selfSpeaking ? "ring-2 ring-ember-300/70 ring-offset-2 ring-offset-ink-950" : ""}`}
      >
        {talking ? <MicrophoneIcon size={20} weight="fill" /> : <MicrophoneSlashIcon size={20} />}
        {failed && (
          <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-away text-ink-950">
            <WarningIcon size={10} weight="fill" />
          </span>
        )}
      </button>
      <button
        onClick={() => voice.toggleCamera()}
        aria-pressed={state.camOn}
        aria-label={state.camOn ? "Turn off camera" : "Turn on camera"}
        title={state.camOn ? "Turn off camera" : "Turn on camera"}
        className={`press grid size-11 shrink-0 place-items-center rounded-2xl select-none transition-colors duration-150 ${
          state.camOn ? "bg-ember-500 text-ink-950" : "glass text-fog-100"
        } max-sm:hidden`}
      >
        {state.camOn ? <VideoCameraIcon size={20} weight="fill" /> : <VideoCameraSlashIcon size={20} />}
      </button>
    </div>
  );
}

// On phones the header is tight: the camera toggle lives with the tiles instead.
export function PhoneCameraButton({ voice, state }: { voice: VoiceSession; state: VoiceState }) {
  if (state.status === "unavailable") return null;
  return (
    <button
      onClick={() => voice.toggleCamera()}
      aria-pressed={state.camOn}
      aria-label={state.camOn ? "Turn off camera" : "Turn on camera"}
      className={`press pointer-events-auto grid size-9 shrink-0 place-items-center rounded-full select-none ${
        state.camOn ? "bg-ember-500 text-ink-950" : "glass text-fog-100"
      }`}
    >
      {state.camOn ? <VideoCameraIcon size={17} weight="fill" /> : <VideoCameraSlashIcon size={17} />}
    </button>
  );
}

// Who's on voice or camera, over the stage: camera tiles, and small chips for voice only.
export function VoiceTiles({ state, compact, extra }: { state: VoiceState; compact?: boolean; extra?: React.ReactNode }) {
  return (
    <div
      className={`pointer-events-none flex gap-2 ${
        compact ? "flex-row items-start overflow-x-auto overscroll-x-contain px-2 [scrollbar-width:none]" : "w-[176px] flex-col items-end"
      }`}
    >
      <AnimatePresence initial={false}>
        {state.peers.map((p) => (
          <motion.div
            key={p.id}
            layout
            initial={{ opacity: 0, scale: 0.9, filter: "blur(6px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.9, filter: "blur(4px)", transition: { duration: 0.15 } }}
            transition={{ type: "spring", bounce: 0, duration: 0.35 }}
            className="pointer-events-auto shrink-0"
          >
            {p.camOn && p.video ? <CameraTile peer={p} compact={compact} /> : <VoiceChip peer={p} />}
          </motion.div>
        ))}
      </AnimatePresence>
      {extra}
    </div>
  );
}

function CameraTile({ peer, compact }: { peer: VoicePeer; compact?: boolean }) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-ink-800 shadow-[0_8px_24px_-8px_rgb(0_0_0/0.6)] ring-2 transition-shadow duration-150 ${
        peer.speaking ? "ring-live" : "ring-white/8"
      } ${compact ? "h-[63px] w-[112px]" : "h-[99px] w-[176px]"}`}
    >
      <TrackVideo track={peer.video!} mirror={peer.self} />
      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pt-4 pb-1 text-[11px] font-semibold text-white">
        {!peer.micOn && <MicrophoneSlashIcon size={11} className="shrink-0 text-fog-300" />}
        <span className="truncate">{peer.self ? "You" : peer.name}</span>
        <QualityDot quality={peer.quality} />
      </span>
    </div>
  );
}

function VoiceChip({ peer }: { peer: VoicePeer }) {
  return (
    <span
      className={`glass flex h-9 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-[12px] font-semibold text-fog-50 ring-2 transition-shadow duration-150 ${
        peer.speaking ? "ring-live" : "ring-transparent"
      }`}
    >
      <Avatar name={peer.name} size={28} />
      <span className="max-w-[9ch] truncate">{peer.self ? "You" : peer.name}</span>
      <MicrophoneIcon size={13} weight={peer.speaking ? "fill" : "regular"} className={peer.speaking ? "text-live" : "text-fog-500"} />
    </span>
  );
}

function TrackVideo({ track, mirror }: { track: Track; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current!;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} muted playsInline className={`size-full object-cover ${mirror ? "-scale-x-100" : ""}`} />;
}

export function QualityDot({ quality }: { quality: "good" | "fair" | "poor" | "unknown" | undefined }) {
  if (!quality || quality === "unknown") return null;
  return (
    <span
      title={quality === "good" ? "Good connection" : quality === "fair" ? "Unsteady connection" : "Struggling connection"}
      className={`ml-auto size-2 shrink-0 rounded-full ${quality === "good" ? "bg-live" : quality === "fair" ? "bg-away" : "bg-danger"}`}
    />
  );
}

export function VoiceNotice({ state }: { state: VoiceState }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(24px,env(safe-area-inset-bottom))] z-50 flex justify-center px-4" aria-live="polite">
      <AnimatePresence>
        {state.notice && (
          <motion.div
            key={state.notice.id}
            initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: 6, transition: { duration: 0.15 } }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
            className="glass-thick max-w-[440px] rounded-2xl px-4 py-2.5 text-center text-[14px] font-medium text-fog-50"
          >
            {state.notice.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
