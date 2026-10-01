import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { CouchIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { ApiError, rooms, type VisitedRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Marquee, Presence, roomTitle } from "./room-bits";

// How long "Removed · Undo" stays before the removal is actually sent.
const UNDO_MS = 5000;

export function RoomList({ me, onCount }: { me?: string; onCount?: (n: number) => void }) {
  const [list, setList] = useState<VisitedRoom[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [ending, setEnding] = useState<VisitedRoom | null>(null);
  const [endBusy, setEndBusy] = useState(false);
  const [endError, setEndError] = useState("");
  // Rooms taken off the list but still inside their undo window, newest last.
  const [removing, setRemoving] = useState<string[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const load = useCallback(() => {
    rooms.visited().then(
      (r) => {
        setList(r);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);

  // Refresh when the tab comes back, so "here now" isn't stale.
  useEffect(() => {
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  // Leaving the page doesn't cancel a removal that's waiting on its undo window.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [code, t] of pending) {
        clearTimeout(t);
        rooms.forget(code).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (list) onCount?.(list.length - removing.length);
  }, [list, removing, onCount]);

  function remove(code: string) {
    setRemoving((r) => [...r.filter((c) => c !== code), code]);
    timers.current.set(
      code,
      setTimeout(async () => {
        timers.current.delete(code);
        try {
          await rooms.forget(code);
          setList((l) => l?.filter((r) => r.code !== code) ?? l);
        } catch {
          // Didn't go through: put it back rather than pretend.
        }
        setRemoving((r) => r.filter((c) => c !== code));
      }, UNDO_MS),
    );
  }

  function undo(code: string) {
    clearTimeout(timers.current.get(code));
    timers.current.delete(code);
    setRemoving((r) => r.filter((c) => c !== code));
  }

  async function confirmEnd() {
    if (!ending) return;
    setEndBusy(true);
    setEndError("");
    try {
      await rooms.end(ending.code);
      setList((l) => l?.filter((r) => r.code !== ending.code) ?? l);
      setEnding(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setList((l) => l?.filter((r) => r.code !== ending.code) ?? l); // already gone
        setEnding(null);
      } else {
        setEndError(err instanceof ApiError ? err.message : "Couldn't reach Anda. Try again.");
      }
    } finally {
      setEndBusy(false);
    }
  }

  if (failed && !list) {
    return (
      <div className="flex flex-col items-start gap-4 py-6" role="alert">
        <p className="inline-flex items-start gap-2 text-[15px] text-danger">
          <WarningCircleIcon size={18} weight="fill" className="mt-px shrink-0" />
          Couldn&rsquo;t load your rooms.
        </p>
        <Button variant="secondary" onClick={load}>
          Try again
        </Button>
      </div>
    );
  }

  if (!list) return <GridSkeleton />;

  const shown = list.filter((r) => !removing.includes(r.code));
  const lastRemoved = removing[removing.length - 1];

  return (
    <>
      {shown.length === 0 && removing.length === 0 ? (
        <Empty />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-4 lg:grid-cols-[repeat(auto-fill,minmax(300px,350px))]">
          <AnimatePresence initial={false} mode="popLayout">
            {shown.map((r) => (
              <motion.li
                key={r.code}
                layout
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96, filter: "blur(4px)", transition: { duration: 0.18 } }}
                transition={{ type: "spring", bounce: 0, duration: 0.35 }}
              >
                <Card
                  room={r}
                  me={me}
                  onEnd={() => {
                    setEndError("");
                    setEnding(r);
                  }}
                  onRemove={() => remove(r.code)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <div className="pointer-events-none fixed inset-x-0 bottom-[max(24px,env(safe-area-inset-bottom))] z-40 flex justify-center px-4" aria-live="polite">
        <AnimatePresence>
          {lastRemoved && (
            <motion.div
              key="undo"
              initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: 12, transition: { duration: 0.15 } }}
              transition={{ type: "spring", bounce: 0, duration: 0.35 }}
              className="pointer-events-auto flex h-14 items-center gap-2 rounded-full bg-ink-700 pr-2 pl-5 shadow-[0_16px_48px_rgb(0_0_0/0.45)]"
            >
              <span className="text-[15px] text-fog-300">
                Removed{removing.length > 1 ? ` ${removing.length} rooms` : ""}
              </span>
              <button
                onClick={() => removing.forEach(undo)}
                className="press h-10 rounded-full px-4 text-[15px] font-semibold text-plum-200 hover:bg-white/8"
              >
                Undo
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ConfirmDialog
        open={!!ending}
        title={`End room ${ending?.code ?? ""}?`}
        body={
          ending && ending.online > 0 ? (
            <>
              {ending.online === 1 ? "1 person is" : `${ending.online} people are`} in it right now and will be sent out. The
              chat is deleted and the code stops working. This can&rsquo;t be undone.
            </>
          ) : (
            <>The chat is deleted and the code stops working for everyone. This can&rsquo;t be undone.</>
          )
        }
        action="End room"
        busy={endBusy}
        error={endError}
        onConfirm={confirmEnd}
        onCancel={() => setEnding(null)}
      />
    </>
  );
}

function Card({ room, me, onEnd, onRemove }: { room: VisitedRoom; me?: string; onEnd: () => void; onRemove: () => void }) {
  const router = useRouter();
  const live = room.online > (me && room.here?.includes(me) ? 1 : 0);
  return (
    <div className="flex h-full flex-col gap-3.5 rounded-[32px] bg-ink-800 p-3.5">
      <Marquee room={room} className="h-[170px] rounded-[24px]" />
      <div className="flex flex-col gap-1.5 px-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-[18px] font-semibold tracking-[-0.01em] text-fog-50">{roomTitle(room)}</p>
          <span className="shrink-0 font-mono text-[13px] tracking-[0.14em] text-plum-200">{room.code}</span>
        </div>
        <Presence room={room} me={me} />
      </div>
      <div className="mt-auto flex gap-2">
        <Button variant={live ? "primary" : "secondary"} onClick={() => router.push(`/room?code=${room.code}`)} className="h-12 flex-1">
          Rejoin
        </Button>
        {room.mine && (
          <Button variant="danger" onClick={onEnd} className="h-12 px-5">
            End room
          </Button>
        )}
        <Button
          variant="secondary"
          size="icon"
          onClick={onRemove}
          aria-label={`Take ${room.code} off your list`}
          title="Take it off your list. The room keeps going."
          className="size-12 text-fog-300"
        >
          <XIcon size={18} />
        </Button>
      </div>
    </div>
  );
}

function Empty() {
  const router = useRouter();
  return (
    <div className="enter flex max-w-[440px] flex-col items-start gap-5 rounded-[32px] bg-ink-800 p-7">
      <span className="grid size-14 place-items-center rounded-full bg-ink-700 text-plum-200">
        <CouchIcon size={26} weight="duotone" />
      </span>
      <p className="text-[16px] leading-relaxed text-fog-300">
        Rooms you start or join show up here, so you can find your way back without the code.
      </p>
      <Button onClick={() => router.push("/")}>Start a room</Button>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-4 lg:grid-cols-[repeat(auto-fill,minmax(300px,350px))]" aria-label="Loading your rooms" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-3.5 rounded-[32px] bg-ink-800 p-3.5">
          <div className="skeleton h-[170px] rounded-[24px]" />
          <div className="skeleton mx-1 h-5 w-2/3 rounded-full" />
          <div className="skeleton mx-1 h-4 w-1/2 rounded-full" />
          <div className="skeleton h-12 rounded-full" />
        </div>
      ))}
    </div>
  );
}
