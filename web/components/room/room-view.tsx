import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FilmSlateIcon, FilmStripIcon } from "@phosphor-icons/react";
import { RoomConnection, type RoomView as View } from "@/lib/room";
import { Projector } from "@/components/projector";
import { Spinner } from "@/components/ui/spinner";
import { RoomHeader } from "./room-header";
import { Chat } from "./chat";
import { ChatSheet } from "./chat-sheet";
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

// Phone portrait: 16:9 stage under a floating header; chat is a sheet that drags over it.
function PhoneLayout({ view, conn, onPick, onSwitch }: LayoutProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState({ top: 0, offset: 0 });
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const header = headerRef.current!.getBoundingClientRect();
      const stage = stageRef.current!.getBoundingClientRect();
      const top = header.bottom + 8;
      setGeo({ top, offset: Math.max(0, stage.bottom - top) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stageRef.current!);
    ro.observe(headerRef.current!);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      <div ref={stageRef} className="relative aspect-video w-full pt-[env(safe-area-inset-top)]">
        <div className={`absolute inset-0 transition-opacity duration-300 ${expanded ? "opacity-40" : ""}`}>
          <Stage view={view} conn={conn} onPick={onPick} onSwitch={onSwitch} compact />
        </div>
      </div>
      <div ref={headerRef} className="absolute inset-x-2 top-[max(8px,env(safe-area-inset-top))] z-20">
        <RoomHeader view={view} conn={conn} />
      </div>
      {geo.top > 0 && (
        <ChatSheet top={geo.top} collapsedOffset={geo.offset} expanded={expanded} onExpandedChange={setExpanded}>
          {(handle) => <Chat view={view} conn={conn} topInset={handle} onComposerFocus={() => setExpanded(true)} />}
        </ChatSheet>
      )}
    </>
  );
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
