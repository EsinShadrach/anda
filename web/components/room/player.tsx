import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowClockwiseIcon,
  CloudArrowDownIcon,
  CornersInIcon,
  CornersOutIcon,
  FilmStripIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  PauseIcon,
  PlayIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
} from "@phosphor-icons/react";
import type { RoomConnection, RoomView } from "@/lib/room";
import { PlayerSync } from "@/lib/player-sync";
import { attachHls } from "@/lib/hls-source";
import { useProgress } from "@/lib/use-progress";
import { Spinner } from "@/components/ui/spinner";

const IDLE_MS = 2600;

export function Player({
  view,
  conn,
  compact,
  onChangeFilm,
}: {
  view: RoomView;
  conn: RoomConnection;
  compact?: boolean; // phone portrait: two-row controls
  onChangeFilm: () => void;
}) {
  const [sync] = useState(() => new PlayerSync(conn));
  const ps = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const media = view.media!;
  const url = media.url;

  // A Library film may still be downloading: it plays as it arrives, but only once a few
  // segments exist, and only up to the prepared point.
  const progress = useProgress(media.id, media.state === "preparing");
  const preparing = media.state === "preparing" && progress?.state !== "ready";
  const failed = progress?.state === "failed" || progress?.state === "incompatible";
  const preparedTo = preparing ? (progress?.prepared_seconds ?? 0) : Infinity;
  const canAttach = !failed && (!preparing || preparedTo >= 12);
  const duration = media.duration || progress?.duration || (Number.isFinite(ps.duration) ? ps.duration : 0);
  const seek = useCallback(
    (t: number) => conn.seek(Math.min(t, preparing ? Math.max(0, preparedTo - 3) : t)),
    [conn, preparing, preparedTo],
  );

  useEffect(() => {
    if (!canAttach) return;
    const video = videoRef.current!;
    let cleanup: (() => void) | undefined;
    let live = true;
    setLoadError(null);
    attachHls(video, url, (msg) => live && setLoadError(msg)).then((c) => {
      if (live) cleanup = c;
      else c();
    });
    sync.attach(video);
    return () => {
      live = false;
      sync.detach();
      cleanup?.();
    };
  }, [sync, url, attempt, canAttach]);

  const wantPlaying = (view.intent?.want ?? view.playback?.want) === "playing";
  const running = view.playback?.want === "playing" && view.blockers.length === 0;
  const isHost = view.me === view.host;

  // Controls stay while paused; while the film runs they fade after a moment of stillness.
  const wake = useCallback(() => {
    setActive(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setActive(false), IDLE_MS);
  }, []);
  useEffect(() => {
    if (!running) {
      clearTimeout(idleTimer.current);
      setActive(true);
    } else wake();
    return () => clearTimeout(idleTimer.current);
  }, [running, wake]);

  const toggle = useCallback(() => (wantPlaying ? conn.pause() : conn.play()), [wantPlaying, conn]);

  const toggleFullscreen = useCallback(() => {
    const frame = frameRef.current!;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (frame.requestFullscreen) frame.requestFullscreen().catch(() => video?.webkitEnterFullscreen?.());
    else video?.webkitEnterFullscreen?.(); // iPhone: native player; the echo rule handles its events
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Keyboard: instant, never animated. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable=true]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const now = conn.targetPosition();
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          toggle();
          break;
        case "ArrowLeft":
        case "j":
          e.preventDefault();
          seek(now - (e.key === "j" ? 10 : 5));
          break;
        case "ArrowRight":
        case "l":
          e.preventDefault();
          seek(now + (e.key === "l" ? 10 : 5));
          break;
        case "f":
          toggleFullscreen();
          break;
        case "m":
          sync.toggleMute();
          break;
        default:
          return;
      }
      wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn, seek, sync, toggle, toggleFullscreen, wake]);

  const shown = active || !running;

  return (
    <div
      ref={frameRef}
      onPointerMove={wake}
      onPointerDown={wake}
      className={`relative size-full overflow-hidden bg-black ${shown ? "" : "cursor-none"}`}
    >
      <video
        ref={videoRef}
        playsInline
        preload="auto"
        className="absolute inset-0 size-full object-contain"
        onClick={() => !compact && toggle()}
        onDoubleClick={toggleFullscreen}
      />

      {/* Top and bottom scrims so glass controls stay legible over bright scenes. */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/70 to-transparent transition-opacity duration-300 ${shown ? "opacity-100" : "opacity-0"}`}
      />

      <StatusChip view={view} conn={conn} className={compact ? "top-[calc(60px+env(safe-area-inset-top))]" : "top-20"} />

      {!ps.needsTap && ps.waiting && running && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Spinner size={36} className="text-fog-100/80" />
        </div>
      )}

      <div
        className={`absolute inset-x-0 bottom-0 transition-[opacity,transform] duration-300 ease-out-strong ${
          shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
        } ${compact ? "p-2" : "p-4"}`}
      >
        <div className={`glass flex flex-col rounded-2xl ${compact ? "gap-1 px-2 pt-2 pb-1" : "gap-2 px-4 pt-3 pb-2"}`}>
          <Scrubber
            time={ps.currentTime}
            duration={duration}
            bufferedEnd={ps.bufferedEnd}
            preparedTo={preparing ? preparedTo : undefined}
            onSeek={seek}
            onScrub={wake}
          />
          <div className="flex items-center gap-1">
            <IconButton label={wantPlaying ? "Pause" : "Play"} onClick={toggle}>
              {wantPlaying ? <PauseIcon size={22} weight="fill" /> : <PlayIcon size={22} weight="fill" />}
            </IconButton>
            {!compact && (
              <IconButton label={ps.muted ? "Unmute" : "Mute"} onClick={() => sync.toggleMute()}>
                {ps.muted || ps.volume === 0 ? <SpeakerSlashIcon size={21} /> : <SpeakerHighIcon size={21} />}
              </IconButton>
            )}
            <span className="ml-1 font-mono text-[12px] text-fog-300 tabular-nums">
              {fmt(ps.currentTime)} <span className="text-fog-600">/ {fmt(duration)}</span>
            </span>
            {preparing && progress && <DownloadBadge progress={progress} />}
            <span className="ml-3 min-w-0 flex-1 truncate text-[13px] font-medium text-fog-300 max-sm:hidden">{media.title}</span>
            <span className="flex-1 sm:hidden" />
            {isHost && (
              <>
                <IconButton
                  label={view.locked ? "Unlock controls for everyone" : "Only I can control playback"}
                  onClick={() => conn.lockControls(!view.locked)}
                  active={view.locked}
                >
                  {view.locked ? <LockSimpleIcon size={20} weight="fill" /> : <LockSimpleOpenIcon size={20} />}
                </IconButton>
                <IconButton label="Change film" onClick={onChangeFilm}>
                  <FilmStripIcon size={20} />
                </IconButton>
              </>
            )}
            {!isHost && view.locked && (
              <span className="flex items-center gap-1 px-2 text-[12px] text-fog-500" title="The host has locked the controls">
                <LockSimpleIcon size={14} weight="fill" /> Host only
              </span>
            )}
            <IconButton label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>
              {fullscreen ? <CornersInIcon size={20} /> : <CornersOutIcon size={20} />}
            </IconButton>
          </div>
        </div>
      </div>

      <Toast view={view} />

      {loadError && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-ink-950/70 backdrop-blur-md">
          <div className="enter flex max-w-[34ch] flex-col items-center gap-3 px-6 text-center">
            <p className="text-lg font-semibold tracking-[-0.02em] text-fog-50">{loadError}</p>
            <p className="text-[14px] text-fog-300">The rest of the room keeps watching. Try again in a moment.</p>
            <button
              onClick={() => setAttempt((n) => n + 1)}
              className="glass press mt-1 flex h-11 items-center gap-2 rounded-xl px-4 text-[15px] font-semibold text-fog-50"
            >
              <ArrowClockwiseIcon size={18} weight="bold" /> Try again
            </button>
          </div>
        </div>
      )}

      <AnimatePresence>
        {(!canAttach || failed) && (
          <motion.div
            key="preparing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
            className="absolute inset-0 z-30 grid place-items-center overflow-hidden bg-ink-950"
          >
            {media.poster && <img src={media.poster} alt="" aria-hidden className="absolute inset-0 size-full scale-110 object-cover opacity-25 blur-2xl" />}
            {failed ? (
              <div className="enter relative flex max-w-[36ch] flex-col items-center gap-3 px-6 text-center">
                <p className="text-lg font-semibold tracking-[-0.02em] text-fog-50">This release didn&rsquo;t work</p>
                <p className="text-[14px] leading-relaxed text-fog-300">
                  {progress?.state === "incompatible"
                    ? "It turned out to need transcoding, which this server can't do."
                    : "Not enough of it could be downloaded."}{" "}
                  {isHost ? "Pick another stream." : "The host can pick another stream."}
                </p>
                {isHost && (
                  <button onClick={onChangeFilm} className="glass press mt-1 flex h-11 items-center gap-2 rounded-xl px-4 text-[15px] font-semibold text-fog-50">
                    <FilmStripIcon size={18} /> Pick another
                  </button>
                )}
              </div>
            ) : (
              <PreparingCard title={media.title} progress={progress} compact={compact} />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {canAttach && ps.needsTap && (
          <motion.button
            key="tap"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            onClick={() => sync.unlock()}
            className="absolute inset-0 z-20 grid place-items-center bg-ink-950/55 backdrop-blur-md"
          >
            <span className="flex flex-col items-center gap-4 px-6 text-center">
              <span className="press grid size-20 place-items-center rounded-full bg-ember-500 text-ink-950 shadow-[0_12px_40px_-8px_rgb(232_131_74/0.7)] max-sm:size-16">
                <PlayIcon size={32} weight="fill" className="translate-x-0.5" />
              </span>
              <span className="flex flex-col gap-1">
                <span className="text-lg font-semibold tracking-[-0.02em] text-fog-50">Join the screening</span>
                <span className="text-[14px] text-fog-300">{media.title}</span>
              </span>
            </span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusChip({ view, conn, className = "" }: { view: RoomView; conn: RoomConnection; className?: string }) {
  const isHost = view.me === view.host;
  const buffering = view.blockers.filter((b) => b.reason === "buffering");
  const ready = view.blockers.filter((b) => b.reason === "getting_ready");
  const want = view.playback?.want;

  let content: React.ReactNode = null;
  let key = "";
  if (view.intent?.want === "playing") {
    key = "starting";
    content = (
      <>
        <Spinner size={14} className="text-ember-400" /> Starting
      </>
    );
  } else if (want === "playing" && buffering.length > 0) {
    const first = buffering[0];
    key = `wait-${first.user_id}`;
    content = (
      <>
        <Spinner size={14} className="text-ember-400" />
        Waiting for {first.user_id === view.me ? "you" : first.username}
        {buffering.length > 1 && ` and ${buffering.length - 1} more`}
        {isHost && first.user_id !== view.me && (
          <button
            onClick={() => conn.skipWait(first.user_id)}
            className="press -my-1 ml-1 rounded-full bg-white/10 px-2.5 py-1 text-[12px] font-semibold text-fog-50 hover:bg-white/15"
          >
            Don&rsquo;t wait
          </button>
        )}
      </>
    );
  } else if (want === "playing" && ready.length > 0) {
    key = "ready";
    content = (
      <>
        <Spinner size={14} className="text-ember-400" /> Getting everyone ready
      </>
    );
  } else if (want === "paused" && view.lastChange?.action === "pause" && view.lastChange.by) {
    key = `paused-${view.lastChange.by}`;
    content = <>Paused by {view.lastChange.by === nameOf(view, view.me) ? "you" : view.lastChange.by}</>;
  }

  return (
    <div className={`pointer-events-none absolute inset-x-0 z-10 flex justify-center ${className}`}>
      <AnimatePresence mode="wait">
        {content && (
          <motion.div
            key={key}
            initial={{ opacity: 0, y: -6, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -6, filter: "blur(4px)", transition: { duration: 0.12 } }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
            role="status"
            className="glass pointer-events-auto flex h-9 items-center gap-2 rounded-full px-4 text-[13px] font-medium text-fog-50"
          >
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Toast({ view }: { view: RoomView }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/3 z-30 flex justify-center" aria-live="assertive">
      <AnimatePresence>
        {view.toast && (
          <motion.div
            key={view.toast.id}
            initial={{ opacity: 0, scale: 0.94, filter: "blur(6px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
            className="glass-thick rounded-2xl px-5 py-3 text-[15px] font-semibold text-fog-50"
          >
            {view.toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Drag or click to seek; arrow keys step 5s. The seek is sent on release, not while dragging.
function Scrubber({
  time,
  duration,
  bufferedEnd,
  preparedTo,
  onSeek,
  onScrub,
}: {
  time: number;
  duration: number;
  bufferedEnd: number;
  preparedTo?: number; // while downloading: how far the film exists yet
  onSeek: (t: number) => void;
  onScrub: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shownTime = drag ?? time;
  const pct = duration ? (shownTime / duration) * 100 : 0;
  const bufPct = duration ? (bufferedEnd / duration) * 100 : 0;

  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shownTime)}
      aria-valuetext={`${fmt(shownTime)} of ${fmt(duration)}`}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          onSeek(time + (e.key === "ArrowRight" ? 5 : -5));
        }
      }}
      onPointerDown={(e) => {
        if (!duration) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e.clientX));
        onScrub();
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        setDrag(at(e.clientX));
        onScrub();
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        onSeek(at(e.clientX));
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      className="group relative flex h-6 cursor-pointer touch-none items-center"
    >
      <div
        className={`relative h-1 w-full overflow-hidden rounded-full bg-white/15 transition-[height] duration-150 group-hover:h-1.5 ${drag !== null ? "h-1.5" : ""}`}
      >
        {preparedTo !== undefined && duration > 0 && (
          <div
            className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(90deg,rgb(255_255_255/0.14)_0_3px,transparent_3px_6px)]"
            style={{ width: `${Math.min(100, (preparedTo / duration) * 100)}%` }}
          />
        )}
        <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${bufPct}%` }} />
        <div className="absolute inset-y-0 left-0 bg-ember-500" style={{ width: `${pct}%` }} />
      </div>
      <div
        className={`absolute size-3.5 -translate-x-1/2 rounded-full bg-fog-50 shadow-[0_2px_8px_rgb(0_0_0/0.4)] transition-transform duration-150 ${
          drag !== null ? "scale-110" : "scale-0 group-hover:scale-100 group-focus-visible:scale-100"
        }`}
        style={{ left: `${pct}%` }}
      />
      {drag !== null && (
        <div
          className="glass absolute bottom-6 -translate-x-1/2 rounded-lg px-2 py-1 font-mono text-[12px] text-fog-50 tabular-nums"
          style={{ left: `${pct}%` }}
        >
          {fmt(drag)}
        </div>
      )}
    </div>
  );
}

function PreparingCard({ title, progress, compact }: { title: string; progress: import("@/lib/api").Progress | null; compact?: boolean }) {
  const pct = progress && progress.size_bytes ? Math.min(100, (progress.downloaded / progress.size_bytes) * 100) : 0;
  return (
    <div className={`enter relative flex w-full max-w-[380px] flex-col items-center gap-4 px-6 text-center ${compact ? "gap-2 pt-10" : ""}`}>
      <span className={`grid place-items-center rounded-2xl bg-ember-500/12 text-ember-400 ring-1 ring-ember-500/20 ${compact ? "size-10" : "size-14"}`}>
        <CloudArrowDownIcon size={compact ? 20 : 28} weight="duotone" />
      </span>
      <div className="flex flex-col gap-1">
        <p className={`font-semibold tracking-[-0.02em] text-fog-50 ${compact ? "text-[16px]" : "text-xl"}`}>Getting {title} ready</p>
        <p className="text-[13px] text-fog-300">
          {!progress || progress.peers === 0
            ? "Finding people to download it from"
            : `From ${progress.peers} ${progress.peers === 1 ? "peer" : "peers"} · ${formatSpeed(progress.speed)}`}
        </p>
      </div>
      <div className="h-1 w-full max-w-[260px] overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-ember-500 transition-[width] duration-700 ease-out" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      {!compact && <p className="text-[12px] text-fog-600">Playback can start in a few seconds. It keeps downloading while you watch.</p>}
    </div>
  );
}

function DownloadBadge({ progress }: { progress: import("@/lib/api").Progress }) {
  const pct = progress.size_bytes ? Math.round((progress.downloaded / progress.size_bytes) * 100) : 0;
  return (
    <span className="ml-3 inline-flex items-center gap-1.5 rounded-full bg-white/8 px-2.5 py-1 text-[12px] font-medium text-fog-300 tabular-nums" title="Still downloading; you can only skip as far as it's got">
      <CloudArrowDownIcon size={14} className="text-ember-400" />
      {pct}%<span className="max-sm:hidden"> · {formatSpeed(progress.speed)}</span>
    </span>
  );
}

function formatSpeed(bytesPerSec: number) {
  const mb = bytesPerSec / 1e6;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSec / 1e3)} KB/s`;
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`press grid size-10 shrink-0 place-items-center rounded-xl hover:bg-white/10 ${active ? "text-ember-400" : "text-fog-100"}`}
    >
      {children}
    </button>
  );
}

function nameOf(view: RoomView, id: number | null) {
  return view.members.find((m) => m.user_id === id)?.username;
}

function fmt(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
