import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FilmReelIcon, FilmSlateIcon, XIcon } from "@phosphor-icons/react";
import { RoomConnection, type RoomView as View } from "@/lib/room";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { VoiceSession, type VoiceState } from "@/lib/voice";
import { sounds } from "@/lib/sounds";
import { PhoneHeader, RoomHeader } from "./room-header";
import { Chat } from "./chat";
import { RoomDialogs } from "./room-dialogs";
import { RoomGone } from "./room-gone";
import { Player, type PlayerLayout } from "./player";
import { Library } from "./library";
import { CamButton, MicButton, VoiceNotice } from "./voice";
import { FilmTiles, PresencePill, SeatRow } from "./couch";
import { ReactionRow, ReactionsPill } from "./player-extras";
import { SoundToggle } from "./sound-toggle";

// Three rooms in one: "wide" (desktop and tablets: film, couch and chat side by side),
// "phone" (portrait: film, couch, chat stacked) and "video" (a phone on its side: the film
// full-bleed, everything else floating over it).
const VIDEO_MQ = "(orientation: landscape) and (max-height: 500px)";
const PHONE_MQ = "(max-width: 767px)";

function useLayout(): PlayerLayout {
  return useSyncExternalStore(
    (cb) => {
      const mqs = [matchMedia(VIDEO_MQ), matchMedia(PHONE_MQ)];
      mqs.forEach((mq) => mq.addEventListener("change", cb));
      return () => mqs.forEach((mq) => mq.removeEventListener("change", cb));
    },
    () => (matchMedia(VIDEO_MQ).matches ? "video" : matchMedia(PHONE_MQ).matches ? "phone" : "wide"),
    () => "wide",
  );
}

export function RoomView({ code }: { code: string }) {
  const [conn] = useState(() => new RoomConnection(code));
  const view = useSyncExternalStore(conn.subscribe, conn.getSnapshot, conn.getSnapshot);
  const layout = useLayout();
  // "new": pick any film. "switch": another release of the film on screen, same timestamp.
  const [picking, setPicking] = useState<"new" | "switch" | null>(null);
  const [voice] = useState(() => new VoiceSession(code));
  const vs = useSyncExternalStore(voice.subscribe, voice.getSnapshot, voice.getSnapshot);

  useEffect(() => {
    conn.start();
    // Fetch the player's hls.js now, while the socket connects, rather than after the
    // room says which film is on: one round trip and ~130 KB off the first frame.
    import("hls.js").catch(() => {});
    return () => conn.stop();
  }, [conn]);

  // Joins, leaves, messages and typing get a soft sound (others' only; see lib/sounds.ts).
  useEffect(() => conn.onEvent((e) => sounds.play(e.kind)), [conn]);

  // Voice connects (receive-only) once we're in the room; mic and camera stay off until asked.
  useEffect(() => {
    if (view.joined) voice.start();
  }, [voice, view.joined]);
  useEffect(() => () => voice.stop(), [voice]);
  useEffect(() => {
    if (view.endedBy || view.notFound) voice.stop();
  }, [voice, view.endedBy, view.notFound]);

  // Browsers only play voices after a gesture: the first tap anywhere unlocks them.
  useEffect(() => {
    if (!vs.needsAudioTap) return;
    const unlock = () => voice.unlockAudio();
    document.addEventListener("pointerdown", unlock, { once: true });
    return () => document.removeEventListener("pointerdown", unlock);
  }, [voice, vs.needsAudioTap]);

  // Hold T to talk (push-to-talk), except while typing.
  useEffect(() => {
    const typing = (e: KeyboardEvent) =>
      e.target instanceof Element && !!e.target.closest("input, textarea, [contenteditable=true]");
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "t" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      voice.holdToTalk(true);
    };
    const up = (e: KeyboardEvent) => e.key.toLowerCase() === "t" && voice.holdToTalk(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [voice]);

  if (view.endedBy) return <RoomGone code={code} endedBy={view.endedBy.id === view.me ? "you" : view.endedBy.username} />;
  if (view.notFound) return <RoomGone code={code} />;

  return (
    <div className="room-bg fixed inset-0 overflow-hidden">
      <Room
        view={view}
        conn={conn}
        voice={voice}
        vs={vs}
        layout={layout}
        onPick={() => setPicking("new")}
        onSwitch={view.media?.catalog_id ? () => setPicking("switch") : undefined}
      />
      <VoiceNotice state={vs} />
      <Library
        open={picking !== null}
        current={
          view.media?.catalog_id
            ? { id: view.media.catalog_id, name: view.media.title, poster: view.media.poster, year: view.media.year }
            : undefined
        }
        switching={picking === "switch"}
        switchAt={picking !== null ? conn.targetPosition() : 0}
        onClose={() => setPicking(null)}
        onPick={(mediaId, switching) => {
          if (switching) conn.switchRelease(mediaId);
          else conn.setMedia(mediaId);
          setPicking(null);
        }}
      />
      <RoomDialogs view={view} conn={conn} />
    </div>
  );
}

// "short" is a phone on its side before a film is on: the wide room without the couch.
type Mode = "wide" | "short" | "phone" | "video";

const ROOT: Record<Mode, string> = {
  wide: "grid size-full grid-cols-[minmax(0,1fr)_300px] grid-rows-[auto_minmax(0,1fr)_auto] gap-x-5 gap-y-4 p-5 xl:grid-cols-[minmax(0,1fr)_340px]",
  short: "grid size-full grid-cols-[minmax(0,1fr)_300px] grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 pl-[max(12px,env(safe-area-inset-left))]",
  phone: "flex size-full flex-col pt-[max(10px,env(safe-area-inset-top))]",
  video: "relative size-full bg-black",
};

const STAGE: Record<Mode, string> = {
  wide: "relative col-start-1 row-start-2 min-h-0 overflow-hidden rounded-[28px] bg-ink-950 shadow-[0_30px_80px_rgb(112_41_99/0.18)]",
  short: "relative col-start-1 row-start-2 min-h-0 overflow-hidden rounded-[22px] bg-ink-950",
  phone: "relative mx-3 mt-3 aspect-video shrink-0 overflow-hidden rounded-[22px] bg-ink-950 shadow-[0_20px_60px_rgb(112_41_99/0.16)]",
  video: "absolute inset-0 bg-black",
};

/**
 * One room, three arrangements: wide (film, couch and chat side by side), phone (stacked)
 * and video (a phone on its side: the film full-bleed, the room floating over it). The
 * stage keeps the same place in the tree in all of them, so turning a phone never remounts
 * the player: a new <video> would lose the browser's permission to play sound.
 */
function Room({
  view,
  conn,
  voice,
  vs,
  layout,
  onPick,
  onSwitch,
}: {
  view: View;
  conn: RoomConnection;
  voice: VoiceSession;
  vs: VoiceState;
  layout: PlayerLayout;
  onPick: () => void;
  onSwitch?: () => void;
}) {
  const mode: Mode = layout === "video" && !view.media ? "short" : layout;
  const here = view.members.filter((m) => m.status === "online").length;

  // Video mode's chat is a drawer; count what arrives while it's shut.
  const [chatOpen, setChatOpen] = useState(false);
  const seen = useRef(view.chat.length);
  if (chatOpen || mode !== "video") seen.current = view.chat.length;
  const unread = view.chat.slice(seen.current).filter((c) => c.kind === "msg" && c.senderId !== view.me).length;

  const top = useCallback(
    (shown: boolean) => (
      <>
        <AnimatePresence>
          {shown && (
            <motion.div
              key="presence"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
            >
              <PresencePill view={view} vs={vs} unread={unread} onChat={() => setChatOpen(true)} />
            </motion.div>
          )}
        </AnimatePresence>
        <FilmTiles view={view} voice={voice} vs={vs} />
      </>
    ),
    [view, vs, voice, unread],
  );
  const bar = useCallback(
    (onMenu: (open: boolean) => void) => (
      <>
        <ReactionsPill onReact={(k) => conn.react(k)} quick={["love", "fire"]} size={36} onOpenChange={onMenu} className="mx-1" />
        <MicButton voice={voice} state={vs} size={40} variant="bare" />
      </>
    ),
    [conn, voice, vs],
  );

  const wideish = mode === "wide" || mode === "short";
  return (
    <div className={ROOT[mode]}>
      {wideish ? (
        <div className="col-start-1 row-start-1 min-w-0">
          <RoomHeader view={view} conn={conn} />
        </div>
      ) : mode === "phone" ? (
        <div className="px-3">
          <PhoneHeader view={view} conn={conn} voice={voice} vs={vs} onChangeFilm={onPick} onSwitch={onSwitch} />
        </div>
      ) : null}

      <div className={STAGE[mode]}>
        <Stage
          view={view}
          conn={conn}
          layout={mode === "short" ? "wide" : mode}
          onPick={onPick}
          onSwitch={onSwitch}
          duck={vs.duckFilm}
          top={mode === "video" ? top : undefined}
          bar={mode === "video" ? bar : undefined}
        />
      </div>

      {mode === "wide" ? (
        <div className="col-start-1 row-start-3 flex h-[132px] items-center gap-3 rounded-[40px] bg-ink-800 px-5">
          <div className="w-[152px] shrink-0 max-lg:w-auto">
            {view.media && <ReactionsPill onReact={(k) => conn.react(k)} size={44} className="w-fit" />}
          </div>
          <SeatRow view={view} conn={conn} voice={voice} vs={vs} size="lg" camerasToggle className="flex-1" />
          <div className="flex w-[152px] shrink-0 justify-end gap-2 max-lg:w-auto">
            <MicButton voice={voice} state={vs} />
            <CamButton voice={voice} state={vs} />
          </div>
        </div>
      ) : mode === "phone" ? (
        <div className="mx-3 mt-3 shrink-0 rounded-[32px] bg-ink-800 py-1">
          <SeatRow view={view} conn={conn} voice={voice} vs={vs} size="md" />
        </div>
      ) : null}

      {wideish ? (
        <aside aria-label="Chat" className="col-start-2 row-span-full row-start-1 flex min-h-0 flex-col overflow-hidden rounded-[32px] bg-ink-850">
          <div className="flex h-16 shrink-0 items-center gap-2 pt-1 pr-3.5 pl-6">
            <h2 className="flex-1 text-[18px] font-semibold tracking-[-0.01em] text-fog-50">Chat</h2>
            <span className="text-[13px] text-fog-500 tabular-nums">{here ? `${here} here now` : ""}</span>
            <SoundToggle />
          </div>
          <Chat view={view} conn={conn} />
        </aside>
      ) : mode === "phone" ? (
        <Chat
          view={view}
          conn={conn}
          className="mt-1"
          above={view.media ? <ReactionRow onReact={(k) => conn.react(k)} className="no-scrollbar overflow-x-auto px-3 pb-2" /> : null}
          lead={
            <>
              <MicButton voice={voice} state={vs} size={52} />
              <CamButton voice={voice} state={vs} size={52} />
            </>
          }
        />
      ) : (
        <AnimatePresence>
          {chatOpen && (
            <motion.aside
              key="chat"
              aria-label="Chat"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%", transition: { type: "spring", bounce: 0, duration: 0.3 } }}
              transition={{ type: "spring", bounce: 0, duration: 0.4 }}
              className="glass-thick absolute inset-y-0 right-0 z-40 flex w-[min(360px,55vw)] flex-col rounded-l-[28px] pr-[env(safe-area-inset-right)]"
            >
              <div className="flex h-14 shrink-0 items-center gap-1 pr-2 pl-5">
                <h2 className="flex-1 text-[16px] font-semibold text-fog-50">Chat</h2>
                <SoundToggle />
                <button
                  onClick={() => setChatOpen(false)}
                  aria-label="Close chat"
                  className="press grid size-10 place-items-center rounded-full text-fog-300 hover:bg-white/10"
                >
                  <XIcon size={18} />
                </button>
              </div>
              <Chat view={view} conn={conn} />
            </motion.aside>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}

// The player once a film is picked; before that, the empty screen.
function Stage({
  view,
  conn,
  layout,
  onPick,
  onSwitch,
  duck,
  top,
  bar,
}: {
  view: View;
  conn: RoomConnection;
  layout: PlayerLayout;
  onPick: () => void;
  onSwitch?: () => void;
  duck: boolean;
  top?: (shown: boolean) => React.ReactNode;
  bar?: (onMenu: (open: boolean) => void) => React.ReactNode;
}) {
  if (view.media && view.playback) {
    // No key per film: the same <video> element carries on across films and release
    // switches, so a browser that allowed sound once keeps allowing it.
    return (
      <Player view={view} conn={conn} layout={layout} duck={duck} onChangeFilm={onPick} onSwitch={onSwitch} top={top} bar={bar} />
    );
  }
  return <EmptyScreen view={view} onPick={onPick} compact={layout === "phone"} />;
}

function EmptyScreen({ view, onPick, compact }: { view: View; onPick: () => void; compact?: boolean }) {
  const isHost = view.me === view.host;
  const host = view.members.find((m) => m.user_id === view.host)?.username;
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      {view.joined ? (
        <div key="ready" className={`enter flex max-w-[36ch] flex-col items-center text-center ${compact ? "gap-2" : "gap-4"}`}>
          <span className={`grid place-items-center rounded-full bg-ink-800 text-plum-200 ${compact ? "size-12" : "size-24"}`}>
            <FilmSlateIcon size={compact ? 24 : 44} weight="duotone" />
          </span>
          <p className={`font-semibold tracking-[-0.025em] text-fog-50 ${compact ? "text-[18px]" : "mt-2 text-[32px] leading-tight"}`}>
            {isHost ? "What are we watching?" : "The screen’s warming up"}
          </p>
          {isHost ? (
            <Button size={compact ? "md" : "lg"} onClick={onPick} className={compact ? "" : "mt-1"}>
              <FilmReelIcon size={20} weight="bold" /> Pick a film
            </Button>
          ) : (
            <p className={`text-fog-300 ${compact ? "text-[14px]" : "text-[17px]"}`}>{host ?? "The host"} is picking a film.</p>
          )}
        </div>
      ) : (
        <p key="finding" className="enter inline-flex items-center gap-2.5 text-[15px] font-medium text-fog-300">
          <Spinner size={16} className="text-plum-200" /> Finding your seat
        </p>
      )}
    </div>
  );
}
