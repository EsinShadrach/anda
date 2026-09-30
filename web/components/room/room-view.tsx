import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FilmSlateIcon } from "@phosphor-icons/react";
import { RoomConnection, type RoomView as View } from "@/lib/room";
import { Projector } from "@/components/projector";
import { Spinner } from "@/components/ui/spinner";
import { RoomHeader } from "./room-header";
import { Chat } from "./chat";
import { ChatSheet } from "./chat-sheet";
import { RoomDialogs } from "./room-dialogs";
import { RoomGone } from "./room-gone";

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

  useEffect(() => {
    conn.start();
    return () => conn.stop();
  }, [conn]);

  if (view.notFound) return <RoomGone code={code} />;

  return (
    <div className="fixed inset-0 overflow-hidden bg-ink-950">
      {phone ? <PhoneLayout view={view} conn={conn} /> : <WideLayout view={view} conn={conn} />}
      <RoomDialogs view={view} conn={conn} />
    </div>
  );
}

// Desktop / tablet / landscape: the stage fills the room; header and chat float over it.
function WideLayout({ view, conn }: { view: View; conn: RoomConnection }) {
  return (
    <>
      <Projector variant="stage" className="absolute inset-0">
        <StageMessage view={view} className="absolute inset-y-0 right-[392px] left-0" />
      </Projector>
      <RoomHeader view={view} className="absolute top-3 right-[392px] left-3 z-20" />
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
function PhoneLayout({ view, conn }: { view: View; conn: RoomConnection }) {
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
        <Projector variant="stage" className="absolute inset-0">
          <StageMessage
            view={view}
            compact
            className={`absolute inset-x-0 top-[calc(56px+env(safe-area-inset-top))] bottom-0 transition-opacity duration-300 ${expanded ? "opacity-0" : ""}`}
          />
        </Projector>
      </div>
      <div ref={headerRef} className="absolute inset-x-2 top-[max(8px,env(safe-area-inset-top))] z-20">
        <RoomHeader view={view} />
      </div>
      {geo.top > 0 && (
        <ChatSheet top={geo.top} collapsedOffset={geo.offset} expanded={expanded} onExpandedChange={setExpanded}>
          {(handle) => <Chat view={view} conn={conn} topInset={handle} onComposerFocus={() => setExpanded(true)} />}
        </ChatSheet>
      )}
    </>
  );
}

function StageMessage({ view, compact, className = "" }: { view: View; compact?: boolean; className?: string }) {
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
            The screen&rsquo;s warming up
          </p>
          <p className={`leading-relaxed text-fog-300/80 ${compact ? "text-[13px]" : "text-[15px]"}`}>
            Picking a film arrives in the next update. The chat&rsquo;s open in the meantime.
          </p>
        </div>
      ) : (
        <p key="finding" className="enter inline-flex items-center gap-2.5 text-[15px] font-medium text-fog-300">
          <Spinner size={16} className="text-ember-400" /> Finding your seat
        </p>
      )}
    </div>
  );
}
