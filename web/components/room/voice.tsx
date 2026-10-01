import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  VideoCameraIcon,
  VideoCameraSlashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { Track } from "livekit-client";
import type { VoiceSession, VoiceState } from "@/lib/voice";

const HOLD_MS = 280; // press longer than this on the mic = push-to-talk

type Look = "solid" | "glass" | "bare";

function look(on: boolean, l: Look) {
  if (on) return "bg-plum-700 text-fog-50";
  return l === "glass" ? "glass text-fog-100" : l === "bare" ? "text-fog-100 hover:bg-white/10" : "bg-ink-700 text-fog-100 hover:bg-ink-600";
}

// Tap the mic to toggle; press and hold it to talk only while held (push-to-talk, also T
// on a keyboard). Hidden when the server has no voice.
export function MicButton({ voice, state, size = 56, variant = "solid" }: { voice: VoiceSession; state: VoiceState; size?: number; variant?: Look }) {
  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; held: boolean }>({ held: false });
  // No voice on this server: still shown (dimmed), and a tap says why.
  const off = state.status === "unavailable";
  const failed = state.status === "failed";
  const talking = state.micOn || state.pushToTalk;
  const selfSpeaking = state.peers.some((p) => p.self && p.speaking);

  const endHold = () => {
    clearTimeout(hold.current.timer);
    if (hold.current.held) voice.holdToTalk(false);
  };

  return (
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
      title={
        off
          ? "Voice isn’t set up on this server"
          : failed
            ? "Voice can’t connect right now"
            : talking
              ? "Mute microphone"
              : "Mic off · tap to turn on, or hold (or hold T) to talk"
      }
      style={{ width: size, height: size }}
      className={`press relative grid shrink-0 place-items-center rounded-full select-none transition-[background-color,box-shadow] duration-150 ${look(talking, variant)} ${
        selfSpeaking ? "shadow-[0_0_0_3px_var(--color-live)]" : ""
      } ${off ? "opacity-45" : ""}`}
    >
      {talking ? <MicrophoneIcon size={Math.round(size * 0.4)} weight="fill" /> : <MicrophoneSlashIcon size={Math.round(size * 0.4)} />}
      {failed && (
        <span className="absolute -top-0.5 -right-0.5 grid size-5 place-items-center rounded-full bg-away text-ink-950">
          <WarningIcon size={11} weight="fill" />
        </span>
      )}
    </button>
  );
}

export function CamButton({ voice, state, size = 56, variant = "solid" }: { voice: VoiceSession; state: VoiceState; size?: number; variant?: Look }) {
  const off = state.status === "unavailable";
  return (
    <button
      onClick={() => voice.toggleCamera()}
      aria-pressed={state.camOn}
      aria-label={state.camOn ? "Turn off camera" : "Turn on camera"}
      title={off ? "Video isn’t set up on this server" : state.camOn ? "Turn off camera" : "Turn on camera"}
      style={{ width: size, height: size }}
      className={`press grid shrink-0 place-items-center rounded-full select-none transition-colors duration-150 ${look(state.camOn, variant)} ${off ? "opacity-45" : ""}`}
    >
      {state.camOn ? (
        <VideoCameraIcon size={Math.round(size * 0.4)} weight="fill" />
      ) : (
        <VideoCameraSlashIcon size={Math.round(size * 0.4)} />
      )}
    </button>
  );
}

export function TrackVideo({ track, mirror, className = "" }: { track: Track; mirror: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current!;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} muted playsInline className={`size-full object-cover ${mirror ? "-scale-x-100" : ""} ${className}`} />;
}

export function VoiceNotice({ state }: { state: VoiceState }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(20px,env(safe-area-inset-top))] z-50 flex justify-center px-4" aria-live="polite">
      <AnimatePresence>
        {state.notice && (
          <motion.div
            key={state.notice.id}
            initial={{ opacity: 0, y: -10, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
            className="glass-thick max-w-[440px] rounded-full px-5 py-2.5 text-center text-[14px] font-medium text-fog-50"
          >
            {state.notice.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
