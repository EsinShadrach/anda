import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowClockwiseIcon, FilmStripIcon, PlayIcon, XIcon } from "@phosphor-icons/react";
import { library, type Film } from "@/lib/api";
import { Button } from "@/components/ui/button";

// The host picks from films already on the server (the "Ready to watch" shelf).
// Search through Stremio arrives with the Library in step 5.
export function FilmPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (f: Film) => void }) {
  return <AnimatePresence>{open && <Picker onClose={onClose} onPick={onPick} />}</AnimatePresence>;
}

function Picker({ onClose, onPick }: { onClose: () => void; onPick: (f: Film) => void }) {
  const [films, setFilms] = useState<Film[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(false);
    setFilms(null);
    library.ready().then(
      (f) => live && setFilms(f),
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-50 grid place-items-end bg-ink-950/60 backdrop-blur-sm sm:place-items-center sm:p-4"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        initial={{ opacity: 0, y: 24, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, y: 24, filter: "blur(4px)", transition: { duration: 0.16 } }}
        transition={{ type: "spring", bounce: 0, duration: 0.38 }}
        className="glass-thick flex max-h-[80dvh] w-full flex-col rounded-t-[28px] pb-[env(safe-area-inset-bottom)] sm:max-w-[460px] sm:rounded-[28px] sm:pb-0"
      >
        <div className="flex items-start justify-between gap-4 p-6 pb-4">
          <div className="flex flex-col gap-1">
            <h2 id="picker-title" className="text-xl font-semibold tracking-[-0.02em] text-fog-50">
              Pick tonight&rsquo;s film
            </h2>
            <p className="text-[14px] text-fog-500">Everyone in the room starts from the beginning, paused.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" className="-mt-1 -mr-2">
            <XIcon size={20} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
          {error ? (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <p className="text-[15px] font-semibold text-fog-100">Couldn&rsquo;t load the films</p>
              <Button variant="glass" onClick={() => setAttempt((n) => n + 1)}>
                <ArrowClockwiseIcon size={18} /> Try again
              </Button>
            </div>
          ) : films === null ? (
            <ul className="flex flex-col gap-1" aria-busy>
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-4 rounded-2xl p-3">
                  <span className="skeleton h-14 w-24 rounded-xl" />
                  <span className="flex flex-1 flex-col gap-2">
                    <span className="skeleton h-4 w-2/3 rounded" />
                    <span className="skeleton h-3 w-1/3 rounded" />
                  </span>
                </li>
              ))}
            </ul>
          ) : films.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <span className="grid size-12 place-items-center rounded-2xl bg-white/5 text-fog-300">
                <FilmStripIcon size={24} weight="duotone" />
              </span>
              <p className="text-[15px] font-semibold text-fog-100">No films on this server yet</p>
              <p className="max-w-[32ch] text-[14px] leading-relaxed text-fog-500">
                Searching and downloading films comes with the Library.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {films.map((f) => (
                <li key={f.id}>
                  <button
                    onClick={() => onPick(f)}
                    className="press group flex w-full items-center gap-4 rounded-2xl p-3 text-left hover:bg-white/5"
                  >
                    <span className="grid h-14 w-24 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-ember-500/25 to-ink-700 text-ember-300 ring-1 ring-white/6">
                      <FilmStripIcon size={24} weight="duotone" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[16px] font-semibold tracking-[-0.01em] text-fog-50">{f.title}</span>
                      <span className="text-[13px] text-fog-500">{formatSize(f.size_bytes)}</span>
                    </span>
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-ember-500 text-ink-950 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 max-sm:opacity-100">
                      <PlayIcon size={18} weight="fill" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function formatSize(bytes: number) {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
