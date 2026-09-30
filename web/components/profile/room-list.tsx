import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRightIcon, ArrowUUpLeftIcon, FilmSlateIcon, PlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ApiError, rooms, type VisitedRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

// How long "Removed · Undo" stays before the removal is actually sent.
const UNDO_MS = 5000;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(ms: number): string {
  const s = (ms - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "just now";
}

export function RoomList({ onCount }: { onCount?: (n: number) => void }) {
  const [list, setList] = useState<VisitedRoom[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [ending, setEnding] = useState<VisitedRoom | null>(null);
  const [endBusy, setEndBusy] = useState(false);
  const [endError, setEndError] = useState("");
  // Rooms showing "Removed · Undo", with the timer that will really remove them.
  const [removing, setRemoving] = useState<Record<string, true>>({});
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
    if (list) onCount?.(list.length - Object.keys(removing).length);
  }, [list, removing, onCount]);

  function remove(code: string) {
    setRemoving((m) => ({ ...m, [code]: true }));
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
        setRemoving(({ [code]: _, ...rest }) => rest);
      }, UNDO_MS),
    );
  }

  function undo(code: string) {
    clearTimeout(timers.current.get(code));
    timers.current.delete(code);
    setRemoving(({ [code]: _, ...rest }) => rest);
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
        <Button variant="glass" onClick={load}>
          Try again
        </Button>
      </div>
    );
  }

  if (!list) return <ListSkeleton />;

  if (list.length === 0) return <Empty />;

  return (
    <>
      <ul className="flex flex-col divide-y divide-ink-700/70 border-y border-ink-700/70">
        <AnimatePresence initial={false} mode="popLayout">
          {list.map((r) => (
            <motion.li
              key={r.code}
              layout
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.18 } }}
              transition={{ type: "spring", bounce: 0, duration: 0.35 }}
            >
              {removing[r.code] ? (
                <Removed code={r.code} onUndo={() => undo(r.code)} />
              ) : (
                <Row
                  room={r}
                  onEnd={() => {
                    setEndError("");
                    setEnding(r);
                  }}
                  onRemove={() => remove(r.code)}
                />
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
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

function Row({ room, onEnd, onRemove }: { room: VisitedRoom; onEnd: () => void; onRemove: () => void }) {
  const router = useRouter();
  const live = room.online > 0;
  return (
    <div className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[20px] font-medium tracking-[0.14em] text-fog-50">{room.code}</span>
          <span className="truncate text-[13px] text-fog-500">{room.mine ? "Yours" : `${room.owner}’s room`}</span>
        </div>
        <p className="flex min-w-0 items-center gap-2 text-[14px] text-fog-300">
          {live ? (
            <>
              <span className="relative flex size-2 shrink-0">
                <span className="absolute inset-0 animate-ping rounded-full bg-live/60 motion-reduce:hidden" />
                <span className="relative size-2 rounded-full bg-live" />
              </span>
              <span className="shrink-0">{room.online} here now</span>
              {room.film && (
                <span className="flex min-w-0 items-center gap-1.5 text-fog-500">
                  <FilmSlateIcon size={15} className="shrink-0" />
                  <span className="truncate">{room.film}</span>
                </span>
              )}
            </>
          ) : (
            <span className="text-fog-500">Quiet &middot; you were last in {ago(room.last_joined_at)}</span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="glass" onClick={() => router.push(`/room?code=${room.code}`)} className="max-sm:flex-1">
          Rejoin
          <ArrowRightIcon size={16} weight="bold" />
        </Button>
        {room.mine ? (
          <Button variant="ghost" onClick={onEnd} className="text-danger/90 hover:text-danger">
            End
          </Button>
        ) : (
          <Button variant="ghost" onClick={onRemove} title="Take it off your list. The room keeps going.">
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

function Removed({ code, onUndo }: { code: string; onUndo: () => void }) {
  return (
    <div className="enter flex items-center justify-between gap-4 py-3.5" aria-live="polite">
      <span className="text-[14px] text-fog-500">
        Removed <span className="font-mono tracking-[0.1em] text-fog-300">{code}</span> from your list
      </span>
      <Button variant="ghost" onClick={onUndo} className="h-9 px-3 text-[14px]">
        <ArrowUUpLeftIcon size={16} weight="bold" />
        Undo
      </Button>
    </div>
  );
}

function Empty() {
  const router = useRouter();
  return (
    <div className="enter flex flex-col items-start gap-4 border-y border-ink-700/70 py-8">
      <p className="max-w-[40ch] text-[16px] leading-relaxed text-fog-300">
        Rooms you start or join show up here, so you can find your way back without the code.
      </p>
      <Button onClick={() => router.push("/")}>
        <PlusIcon size={18} weight="bold" />
        Start a room
      </Button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col divide-y divide-ink-700/70 border-y border-ink-700/70" aria-label="Loading your rooms" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-6 py-5">
          <div className="flex flex-1 flex-col gap-2.5">
            <div className="skeleton h-6 w-32 rounded-lg" />
            <div className="skeleton h-4 w-48 rounded-md" />
          </div>
          <div className="skeleton h-11 w-24 rounded-xl max-sm:hidden" />
        </div>
      ))}
    </div>
  );
}
