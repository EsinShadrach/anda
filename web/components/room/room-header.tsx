import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  BellSimpleIcon,
  BellSimpleSlashIcon,
  CheckIcon,
  DotsThreeIcon,
  EyeIcon,
  EyeSlashIcon,
  FilmReelIcon,
  LinkSimpleIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
} from "@phosphor-icons/react";
import type { RoomConnection, RoomView } from "@/lib/room";
import type { VoiceSession, VoiceState } from "@/lib/voice";
import { Spinner } from "@/components/ui/spinner";
import { MenuItem, Popover } from "@/components/ui/popover";
import { sounds } from "@/lib/sounds";
import { useSoundsOn } from "./sound-toggle";

export function BackButton({ className = "" }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      onClick={() => router.push("/")}
      aria-label="Leave room"
      title="Leave room"
      className={`press grid size-11 shrink-0 place-items-center rounded-full bg-ink-800 text-fog-100 hover:bg-ink-700 hover:text-fog-50 ${className}`}
    >
      <ArrowLeftIcon size={20} />
    </button>
  );
}

// Wide screens: out, the room code (tap to invite), and what's on.
export function RoomHeader({ view, conn }: { view: RoomView; conn: RoomConnection }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3">
      <BackButton />
      <InviteChip code={view.code} />
      <Reconnecting visible={view.status === "reconnecting"} />
      <div className="flex-1" />
      <NowPlaying view={view} conn={conn} />
    </header>
  );
}

// Phones: out, the code, and a menu with what doesn't fit on screen.
export function PhoneHeader({
  view,
  conn,
  voice,
  vs,
  onChangeFilm,
  onSwitch,
}: {
  view: RoomView;
  conn: RoomConnection;
  voice: VoiceSession;
  vs: VoiceState;
  onChangeFilm: () => void;
  onSwitch?: () => void;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2">
      <BackButton />
      <InviteChip code={view.code} compact />
      <Reconnecting visible={view.status === "reconnecting"} />
      <div className="flex-1" />
      <RoomMenu view={view} conn={conn} voice={voice} vs={vs} onChangeFilm={onChangeFilm} onSwitch={onSwitch} />
    </header>
  );
}

/** "Sintel · 6:21 of 14:48", the room's clock ticking once a second. */
function NowPlaying({ view, conn }: { view: RoomView; conn: RoomConnection }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const playing = view.playback?.want === "playing";
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [playing]);
  if (!view.media || !view.playback) return null;
  const d = view.media.duration;
  return (
    <p className="min-w-0 truncate text-[14px] text-fog-300">
      <span className="font-medium text-fog-100">{view.media.title}</span>
      <span className="text-fog-600"> · </span>
      <span className="tabular-nums">{clock(conn.targetPosition())}</span>
      {d ? <span className="tabular-nums"> of {clock(d)}</span> : null}
    </p>
  );
}

export function InviteChip({ code, compact }: { code: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function invite() {
    const url = `${location.origin}/room?code=${code}`;
    try {
      // Phones get the share sheet; everything else copies the link.
      if (navigator.share && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: "Join my room on Anda", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Share sheet dismissed or clipboard blocked.
    }
  }

  return (
    <button
      onClick={invite}
      aria-label={`Room code ${code}. Invite people`}
      title="Copy the invite link"
      className="press flex h-11 items-center gap-3 rounded-full bg-ink-800 px-4 hover:bg-ink-700"
    >
      <span className="font-mono text-[15px] font-medium tracking-[0.14em] text-plum-200">{code}</span>
      {!compact && (
        <span className="relative grid text-[14px] text-fog-500" aria-hidden>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={copied ? "done" : "invite"}
              initial={{ opacity: 0, y: 4, filter: "blur(3px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -4, filter: "blur(3px)" }}
              transition={{ type: "spring", bounce: 0, duration: 0.25 }}
              className={`inline-flex items-center gap-1 ${copied ? "text-live" : ""}`}
            >
              {copied ? (
                <>
                  <CheckIcon size={14} weight="bold" /> Copied
                </>
              ) : (
                "Invite"
              )}
            </motion.span>
          </AnimatePresence>
        </span>
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? "Invite link copied" : ""}
      </span>
    </button>
  );
}

// Appears only if reconnecting lasts past 600ms, so a quick resume never flashes it.
function Reconnecting({ visible }: { visible: boolean }) {
  return (
    <div
      role="status"
      data-visible={visible}
      className="pointer-events-none flex h-9 items-center gap-2 rounded-full bg-ink-800 px-3 text-[13px] font-medium text-fog-100 opacity-0 transition-opacity duration-200 data-[visible=true]:opacity-100 data-[visible=true]:delay-600"
    >
      <Spinner size={14} className="text-plum-200" />
      <span className="max-sm:sr-only">Reconnecting</span>
    </div>
  );
}

function RoomMenu({
  view,
  conn,
  voice,
  vs,
  onChangeFilm,
  onSwitch,
}: {
  view: RoomView;
  conn: RoomConnection;
  voice: VoiceSession;
  vs: VoiceState;
  onChangeFilm: () => void;
  onSwitch?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const isHost = view.me === view.host;
  const anyCamera = vs.peers.some((p) => p.camOn);
  const soundsOn = useSoundsOn();
  const run = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  async function invite() {
    const url = `${location.origin}/room?code=${view.code}`;
    try {
      if (navigator.share) await navigator.share({ title: "Join my room on Anda", url });
      else await navigator.clipboard.writeText(url);
    } catch {
      // dismissed
    }
  }

  return (
    <>
      <button
        ref={ref}
        onClick={() => setOpen((o) => !o)}
        aria-label="Room options"
        aria-expanded={open}
        className="press grid size-11 shrink-0 place-items-center rounded-full bg-ink-800 text-fog-100 hover:bg-ink-700"
      >
        <DotsThreeIcon size={22} weight="bold" />
      </button>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="bottom" label="Room options" className="w-[256px]">
        <MenuItem icon={<LinkSimpleIcon size={18} />} onClick={run(invite)}>
          Invite people
        </MenuItem>
        {isHost && (
          <MenuItem icon={<FilmReelIcon size={18} />} onClick={run(onChangeFilm)}>
            {view.media ? "Change film" : "Pick a film"}
          </MenuItem>
        )}
        {isHost && view.media && onSwitch && (
          <MenuItem icon={<ArrowsClockwiseIcon size={18} />} onClick={run(onSwitch)}>
            Other releases
          </MenuItem>
        )}
        {isHost && view.media && (
          <MenuItem
            icon={view.locked ? <LockSimpleIcon size={18} weight="fill" /> : <LockSimpleOpenIcon size={18} />}
            checked={view.locked}
            onClick={run(() => conn.lockControls(!view.locked))}
          >
            {view.locked ? "Let everyone control" : "Only I control playback"}
          </MenuItem>
        )}
        {anyCamera && (
          <MenuItem
            icon={vs.tilesHidden ? <EyeIcon size={18} /> : <EyeSlashIcon size={18} />}
            onClick={run(() => voice.setTilesHidden(!vs.tilesHidden))}
          >
            {vs.tilesHidden ? "Show cameras" : "Hide cameras"}
          </MenuItem>
        )}
        <MenuItem
          icon={soundsOn ? <BellSimpleIcon size={18} /> : <BellSimpleSlashIcon size={18} />}
          checked={soundsOn}
          onClick={() => sounds.setEnabled(!soundsOn)}
        >
          {soundsOn ? "Mute room sounds" : "Turn room sounds on"}
        </MenuItem>
        {!isHost && view.locked && (
          <p className="flex items-center gap-2 px-3 py-2 text-[13px] text-fog-500">
            <LockSimpleIcon size={14} weight="fill" /> The host has the remote
          </p>
        )}
      </Popover>
    </>
  );
}

export function clock(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
