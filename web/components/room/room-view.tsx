import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FilmSlateIcon, FilmStripIcon } from "@phosphor-icons/react";
import { motion, useMotionValue, useTransform } from "motion/react";
import { RoomConnection, type RoomView as View } from "@/lib/room";
import { Projector } from "@/components/projector";
import { Spinner } from "@/components/ui/spinner";
import { RoomHeader } from "./room-header";
import { Chat } from "./chat";
import { ChatSheet, type ChatMode } from "./chat-sheet";
import { RoomDialogs } from "./room-dialogs";
import { RoomGone } from "./room-gone";
import { Player } from "./player";
import { Library } from "./library";
import { Button } from "@/components/ui/button";

function useIsPhone() {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia("(max-width: 767px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => matchMedia("(max-width: 767px)").matches,
    () => false,
  );
}

export function RoomView({ code }: { code: string }) {
  const [conn] = useState(() => new RoomConnection(code));
  const view = useSyncExternalStore(conn.subscribe, conn.getSnapshot, conn.getSnapshot);
  const phone = useIsPhone();
  // "new": pick any film. "switch": another release of the film on screen, same timestamp.
  const [picking, setPicking] = useState<"new" | "switch" | null>(null);

  useEffect(() => {
    conn.start();
    return () => conn.stop();
  }, [conn]);

  if (view.endedBy) return <RoomGone code={code} endedBy={view.endedBy.id === view.me ? "you" : view.endedBy.username} />;
  if (view.notFound) return <RoomGone code={code} />;

  return (
    <div className="fixed inset-0 overflow-hidden bg-ink-950">
      {phone ? (
        <PhoneLayout view={view} conn={conn} onPick={() => setPicking("new")} onSwitch={() => setPicking("switch")} />
      ) : (
        <WideLayout view={view} conn={conn} onPick={() => setPicking("new")} onSwitch={() => setPicking("switch")} />
      )}
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

// Desktop / tablet / landscape: the stage fills the room; header and chat float over it.
type LayoutProps = { view: View; conn: RoomConnection; onPick: () => void; onSwitch: () => void };

function WideLayout({ view, conn, onPick, onSwitch }: LayoutProps) {
  return (
    <>
      <div className="absolute inset-y-0 right-[392px] left-0">
        <Stage view={view} conn={conn} onPick={onPick} onSwitch={onSwitch} />
      </div>
      <RoomHeader view={view} conn={conn} className="absolute top-3 right-[392px] left-3 z-20" />
      <aside aria-label="Chat" className="glass-thick absolute top-3 right-3 bottom-3 z-10 flex w-[368px] flex-col overflow-hidden rounded-[24px]">
        <div className="flex h-14 shrink-0 items-center justify-between px-5">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fog-50">Chat</h2>
          <span className="text-[13px] text-fog-500 tabular-nums">
            {view.members.filter((m) => m.status === "online").length} here now
          </span>
        </div>
        <div className="h-px shrink-0 bg-gradient-to-r from-transparent via-white/8 to-transparent" />
        <Chat view={view} conn={conn} />
      </aside>
    </>
  );
}

// Phone portrait: 16:9 stage under a floating header; chat is a sheet that drags over it,
// or away entirely (then the stage takes the whole screen).
function PhoneLayout({ view, conn, onPick, onSwitch }: LayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState({ top: 0, docked: 0, full: 0 });
  const [mode, setMode] = useState<ChatMode>(readChatMode);

  // One value drives both: the sheet's clip, and below the docked point, the stage's height,
  // so the film grows with the finger as chat is pulled away.
  const y = useMotionValue(0);
  const top = useMotionValue(0);
  const dockedHeight = useMotionValue(0);
  const stageHeight = useTransform([y, top, dockedHeight], ([v, t, d]: number[]) => Math.max(d, t + v));

  useLayoutEffect(() => {
    const measure = () => {
      const header = headerRef.current!.getBoundingClientRect();
      const docked = sizerRef.current!.getBoundingClientRect();
      const full = rootRef.current!.getBoundingClientRect().height;
      const t = header.bottom + 8;
      setGeo({ top: t, docked: Math.max(0, docked.bottom - t), full: full - t });
      top.set(t);
      dockedHeight.set(docked.height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sizerRef.current!);
    ro.observe(headerRef.current!);
    ro.observe(rootRef.current!);
    return () => ro.disconnect();
  }, [top, dockedHeight]);

  const changeMode = (m: ChatMode) => {
    setMode(m);
    try {
      if (m === "closed") localStorage.setItem(CHAT_KEY, "closed");
      else localStorage.removeItem(CHAT_KEY);
    } catch {
      // storage blocked: it just won't be remembered
    }
  };

  // Messages that arrived while chat was closed, for the header's badge.
  const seen = useRef(view.chat.length);
  if (mode !== "closed") seen.current = view.chat.length;
  const unread = view.chat.slice(seen.current).filter((c) => c.kind === "msg" && c.senderId !== view.me).length;

  return (
    <div ref={rootRef} className="absolute inset-0">
      {/* Measures the docked stage: full width, 16:9, under the status bar. */}
      <div ref={sizerRef} aria-hidden className="pointer-events-none invisible absolute inset-x-0 top-0 aspect-video pt-[env(safe-area-inset-top)]" />
      <motion.div style={{ height: stageHeight }} className="absolute inset-x-0 top-0">
        <div className={`absolute inset-0 transition-opacity duration-300 ${mode === "open" ? "opacity-40" : ""}`}>
          <Stage view={view} conn={conn} onPick={onPick} onSwitch={onSwitch} compact />
        </div>
      </motion.div>
      <div ref={headerRef} className="absolute inset-x-2 top-[max(8px,env(safe-area-inset-top))] z-20">
        <RoomHeader view={view} conn={conn} chat={mode === "closed" ? { unread, onOpen: () => changeMode("docked") } : undefined} />
      </div>
      {geo.top > 0 && (
        <ChatSheet y={y} top={geo.top} dockedOffset={geo.docked} closedOffset={geo.full} mode={mode} onModeChange={changeMode}>
          {(handle) => <Chat view={view} conn={conn} topInset={handle} onComposerFocus={() => changeMode("open")} />}
        </ChatSheet>
      )}
    </div>
  );
}

const CHAT_KEY = "anda.chat";

function readChatMode(): ChatMode {
  try {
    return localStorage.getItem(CHAT_KEY) === "closed" ? "closed" : "docked";
  } catch {
    return "docked";
  }
}

// The player once a film is picked; before that, the idle screen.
function Stage({ view, conn, onPick, onSwitch, compact }: LayoutProps & { compact?: boolean }) {
  if (view.media && view.playback) {
    // No key per film: the same <video> element carries on across films and release
    // switches, so a browser that allowed sound once keeps allowing it.
    return (
      <Player view={view} conn={conn} compact={compact} onChangeFilm={onPick} onSwitch={view.media.catalog_id ? onSwitch : undefined} />
    );
  }
  return (
    <Projector variant="stage" className="absolute inset-0">
      <StageMessage
        view={view}
        onPick={onPick}
        compact={compact}
        className={compact ? "absolute inset-x-0 top-[calc(56px+env(safe-area-inset-top))] bottom-0" : "absolute inset-0"}
      />
    </Projector>
  );
}

function StageMessage({
  view,
  onPick,
  compact,
  className = "",
}: {
  view: View;
  onPick: () => void;
  compact?: boolean;
  className?: string;
}) {
  const isHost = view.me === view.host;
  const host = view.members.find((m) => m.user_id === view.host)?.username;
  return (
    <div className={`flex items-center justify-center p-6 ${className}`}>
      {view.joined ? (
        <div key="ready" className="enter flex max-w-[34ch] flex-col items-center gap-3 text-center">
          {!compact && (
            <span className="grid size-14 place-items-center rounded-2xl bg-white/5 text-fog-300 ring-1 ring-white/8 backdrop-blur-md">
              <FilmSlateIcon size={28} weight="duotone" />
            </span>
          )}
          <p className={`font-semibold tracking-[-0.02em] text-fog-50 ${compact ? "text-[17px]" : "text-2xl"}`}>
            {isHost ? "What are we watching?" : "The screen\u2019s warming up"}
          </p>
          {isHost ? (
            <Button size={compact ? "md" : "lg"} onClick={onPick} className={compact ? "mt-1" : "mt-2"}>
              <FilmStripIcon size={20} weight="bold" /> Pick a film
            </Button>
          ) : (
            <p className={`leading-relaxed text-fog-300/80 ${compact ? "text-[13px]" : "text-[15px]"}`}>
              Waiting for {host ?? "the host"} to pick a film. The chat&rsquo;s open in the meantime.
            </p>
          )}
        </div>
      ) : (
        <p key="finding" className="enter inline-flex items-center gap-2.5 text-[15px] font-medium text-fog-300">
          <Spinner size={16} className="text-ember-400" /> Finding your seat
        </p>
      )}
    </div>
  );
}
