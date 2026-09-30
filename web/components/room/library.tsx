import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowClockwiseIcon,
  CaretLeftIcon,
  CheckCircleIcon,
  FilmStripIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  UsersIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ApiError, library, type CatalogFilm, type Film, type FilmDetails, type LibraryStream } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Props = { open: boolean; onClose: () => void; onPick: (mediaId: number) => void };

// The host's Library: films already on the server, free open films, search through the
// catalog, and each film's playable streams. Picking a stream starts it downloading and
// puts it on the room's screen straight away (it plays as it arrives).
export function Library({ open, onClose, onPick }: Props) {
  return <AnimatePresence>{open && <Sheet onClose={onClose} onPick={onPick} />}</AnimatePresence>;
}

function Sheet({ onClose, onPick }: Omit<Props, "open">) {
  const [query, setQuery] = useState("");
  const [film, setFilm] = useState<CatalogFilm | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (film) setFilm(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [film, onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-50 flex items-end bg-ink-950/60 backdrop-blur-sm sm:items-center sm:justify-center sm:p-6"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Library"
        initial={{ opacity: 0, y: 28, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, y: 28, filter: "blur(4px)", transition: { duration: 0.16 } }}
        transition={{ type: "spring", bounce: 0, duration: 0.4 }}
        className="glass-thick relative flex h-[92dvh] w-full flex-col overflow-hidden rounded-t-[28px] sm:h-[min(820px,88dvh)] sm:max-w-[960px] sm:rounded-[28px]"
      >
        {film ? (
          <FilmView key={film.id} film={film} onBack={() => setFilm(null)} onClose={onClose} onPick={onPick} />
        ) : (
          <>
            <header className="flex items-center gap-3 p-4 pb-3 sm:p-6 sm:pb-4">
              <SearchBox value={query} onChange={setQuery} />
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close library">
                <XIcon size={20} />
              </Button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(20px,env(safe-area-inset-bottom))] sm:px-6">
              {query.trim() ? (
                <Results key="results" query={query.trim()} onOpen={setFilm} />
              ) : (
                <Browse key="browse" onOpen={setFilm} onPick={onPick} />
              )}
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Desktop only: on phones, focusing would throw the keyboard over the shelf.
    if (matchMedia("(pointer: fine)").matches) ref.current?.focus();
  }, []);
  return (
    <label className="flex h-12 min-w-0 flex-1 items-center gap-3 rounded-2xl bg-ink-800/80 px-4 ring-1 ring-white/6 focus-within:ring-ember-500/70">
      <MagnifyingGlassIcon size={20} className="shrink-0 text-fog-500" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search films"
        aria-label="Search films"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        className="h-full min-w-0 flex-1 bg-transparent text-base text-fog-50 outline-none placeholder:text-fog-600"
      />
      {value && (
        <button onClick={() => onChange("")} aria-label="Clear search" className="press grid size-7 place-items-center rounded-full text-fog-500 hover:bg-white/10 hover:text-fog-100">
          <XIcon size={15} weight="bold" />
        </button>
      )}
    </label>
  );
}

// No query: what's ready right now, and the free open films.
function Browse({ onOpen, onPick }: { onOpen: (f: CatalogFilm) => void; onPick: (id: number) => void }) {
  const [ready, setReady] = useState<Film[] | null>(null);
  const [free, setFree] = useState<CatalogFilm[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setError(false);
    library.ready().then(setReady, () => setError(true));
    library.search("", ac.signal).then(setFree, (e: Error) => e.name !== "AbortError" && setError(true));
    return () => ac.abort();
  }, [attempt]);

  if (error) return <LoadError onRetry={() => setAttempt((n) => n + 1)} />;

  return (
    <div className="enter flex flex-col gap-8 pt-2">
      {(ready === null || ready.length > 0) && (
        <section className="flex flex-col gap-3">
          <SectionTitle title="Ready to watch" hint="Already on the server. Starts instantly." />
          {ready === null ? (
            <PosterGrid>{skeletonPosters(4)}</PosterGrid>
          ) : (
            <PosterGrid>
              {ready.map((f) => (
                <Poster
                  key={f.id}
                  name={f.title}
                  year={f.year}
                  poster={f.poster}
                  badge={
                    <span className="inline-flex items-center gap-1 rounded-full bg-live/15 px-2 py-0.5 text-[11px] font-semibold text-live ring-1 ring-live/25 backdrop-blur-md">
                      <CheckCircleIcon size={12} weight="fill" /> Ready
                    </span>
                  }
                  onClick={() => onPick(f.id)}
                />
              ))}
            </PosterGrid>
          )}
        </section>
      )}
      <section className="flex flex-col gap-3">
        <SectionTitle title="Free to watch" hint="Open films from the Blender Foundation, shared under Creative Commons." />
        {free === null ? (
          <PosterGrid>{skeletonPosters(4)}</PosterGrid>
        ) : (
          <PosterGrid>
            {free.map((f) => (
              <Poster key={f.id} name={f.name} year={f.year} poster={f.poster} onClick={() => onOpen(f)} />
            ))}
          </PosterGrid>
        )}
      </section>
    </div>
  );
}

function Results({ query, onOpen }: { query: string; onOpen: (f: CatalogFilm) => void }) {
  const [films, setFilms] = useState<CatalogFilm[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    // Type-ahead: wait for a pause in typing, and drop answers to older queries.
    const t = setTimeout(() => {
      setFilms(null);
      library.search(query, ac.signal).then(setFilms, (e: Error) => {
        if (e.name !== "AbortError") setError(e instanceof ApiError ? e.message : "Search is unavailable right now.");
      });
    }, 280);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [query]);

  if (error)
    return (
      <p className="enter flex items-center gap-2 pt-6 text-[15px] text-fog-300">
        <WarningCircleIcon size={18} className="text-danger" /> {error}
      </p>
    );
  if (films === null) return <PosterGrid>{skeletonPosters(10)}</PosterGrid>;
  if (films.length === 0)
    return (
      <div className="enter flex flex-col items-center gap-2 py-16 text-center">
        <p className="text-[16px] font-semibold text-fog-100">Nothing called &ldquo;{query}&rdquo;</p>
        <p className="text-[14px] text-fog-500">Try the original title, or fewer words.</p>
      </div>
    );
  return (
    <PosterGrid className="enter pt-2">
      {films.map((f) => (
        <Poster key={f.id} name={f.name} year={f.year} poster={f.poster} free={f.free} onClick={() => onOpen(f)} />
      ))}
    </PosterGrid>
  );
}

function FilmView({
  film,
  onBack,
  onClose,
  onPick,
}: {
  film: CatalogFilm;
  onBack: () => void;
  onClose: () => void;
  onPick: (id: number) => void;
}) {
  const [data, setData] = useState<{ meta: FilmDetails; streams: LibraryStream[]; hidden: Record<string, number>; failed?: string[] } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setError(false);
    setData(null);
    library.streams(film.id, ac.signal).then(setData, (e: Error) => e.name !== "AbortError" && setError(true));
    return () => ac.abort();
  }, [film.id, attempt]);

  async function play(s: LibraryStream) {
    setStarting(s.key);
    setPickError(null);
    try {
      const f = await library.prepare(film.id, s.key);
      onPick(f.id);
    } catch (e) {
      setPickError(e instanceof ApiError ? e.message : "Couldn't start that stream.");
      setStarting(null);
    }
  }

  const meta = data?.meta;
  const poster = meta?.poster || film.poster;
  const hiddenCount = data ? Object.values(data.hidden).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="enter relative flex min-h-0 flex-1 flex-col">
      {/* Backdrop: the film's own art, dimmed so text stays legible. */}
      {meta?.background && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden" aria-hidden>
          <img src={meta.background} alt="" className="size-full object-cover opacity-35" />
          <div className="absolute inset-0 bg-gradient-to-b from-ink-900/30 via-ink-900/70 to-ink-900" />
        </div>
      )}
      <header className="relative flex items-center justify-between p-4 sm:p-6 sm:pb-2">
        <Button variant="glass" size="icon" onClick={onBack} aria-label="Back to search">
          <CaretLeftIcon size={20} weight="bold" />
        </Button>
        <Button variant="glass" size="icon" onClick={onClose} aria-label="Close library">
          <XIcon size={20} />
        </Button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(24px,env(safe-area-inset-bottom))] sm:px-6">
        <div className="flex gap-5">
          <div className="w-28 shrink-0 sm:w-40">
            <PosterImage name={film.name} poster={poster} />
          </div>
          <div className="flex min-w-0 flex-col gap-2 pt-1">
            <h2 className="text-2xl leading-tight font-semibold tracking-[-0.02em] text-fog-50 sm:text-3xl">{meta?.name || film.name}</h2>
            <p className="text-[14px] text-fog-300">
              {[meta?.year || film.year, meta?.runtime, meta?.genres?.slice(0, 3).join(", ")].filter(Boolean).join(" · ")}
            </p>
            {meta?.description ? (
              <p className="line-clamp-4 max-w-[62ch] text-[14px] leading-relaxed text-fog-300/90 max-sm:hidden">{meta.description}</p>
            ) : (
              !data && !error && <span className="skeleton mt-1 h-16 w-full max-w-md rounded-lg max-sm:hidden" />
            )}
          </div>
        </div>
        {meta?.description && <p className="mt-4 line-clamp-5 text-[14px] leading-relaxed text-fog-300/90 sm:hidden">{meta.description}</p>}

        <section className="mt-7 flex flex-col gap-3">
          <h3 className="text-[13px] font-semibold tracking-[0.06em] text-fog-500 uppercase">Streams</h3>
          {error ? (
            <LoadError onRetry={() => setAttempt((n) => n + 1)} />
          ) : !data ? (
            <ul className="flex flex-col gap-2" aria-busy>
              {[0, 1, 2].map((i) => (
                <li key={i} className="skeleton h-[68px] rounded-2xl" />
              ))}
            </ul>
          ) : data.streams.length === 0 ? (
            <div className="rounded-2xl bg-white/4 p-5 text-[14px] leading-relaxed text-fog-300">
              <p className="font-semibold text-fog-100">No streams this server can play</p>
              <p className="mt-1 text-fog-500">
                {hiddenCount > 0
                  ? `${hiddenCount} found, but they need transcoding (HEVC, 10-bit, DTS or AC3 audio) or are over 4 GB.`
                  : data.failed?.length
                    ? `${data.failed.join(" and ")} didn't answer, so there's nothing to show yet.`
                    : "None of the configured sources have this film."}
              </p>
              {data.failed?.length ? (
                <Button variant="glass" onClick={() => setAttempt((n) => n + 1)} className="mt-3">
                  <ArrowClockwiseIcon size={18} /> Try again
                </Button>
              ) : null}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.streams.map((s) => (
                <li key={s.key}>
                  <StreamRow stream={s} starting={starting === s.key} disabled={starting !== null} onPlay={() => play(s)} />
                </li>
              ))}
            </ul>
          )}
          {pickError && (
            <p role="alert" className="enter flex items-center gap-2 text-[14px] text-danger">
              <WarningCircleIcon size={17} weight="fill" /> {pickError}
            </p>
          )}
          {data && data.streams.length > 0 && hiddenCount > 0 && (
            <p className="text-[13px] leading-relaxed text-fog-600">{hiddenText(data.hidden)}</p>
          )}
          {data && data.streams.length > 0 && data.failed?.length ? (
            <p className="text-[13px] leading-relaxed text-fog-600">{data.failed.join(" and ")} didn&rsquo;t answer; showing the rest.</p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function StreamRow({ stream, starting, disabled, onPlay }: { stream: LibraryStream; starting: boolean; disabled: boolean; onPlay: () => void }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-white/4 p-3 pl-4 ring-1 ring-white/5">
      <span className="grid h-9 w-14 shrink-0 place-items-center rounded-lg bg-ink-700 font-mono text-[12px] font-semibold text-fog-100" title={stream.quality ? undefined : "Resolution not stated by the source"}>
        {stream.quality ?? <FilmStripIcon size={17} className="text-fog-500" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-[12.5px] text-fog-100" title={stream.release}>
          {stream.release}
        </span>
        <span className="flex items-center gap-2 text-[12px] text-fog-500">
          <span className="truncate">{stream.source}</span>
          {stream.size_bytes ? <span>· {formatSize(stream.size_bytes)}</span> : null}
          {stream.seeders ? (
            <span className="inline-flex items-center gap-1">
              · <UsersIcon size={12} /> {stream.seeders}
            </span>
          ) : null}
        </span>
      </span>
      <Button size="md" onClick={onPlay} loading={starting} disabled={disabled && !starting} className="shrink-0">
        <PlayIcon size={16} weight="fill" /> <span className="max-sm:hidden">Play in room</span>
        <span className="sm:hidden">Play</span>
      </Button>
    </div>
  );
}

function PosterGrid({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 ${className}`}>{children}</div>;
}

function Poster({
  name,
  year,
  poster,
  free,
  badge,
  onClick,
}: {
  name: string;
  year?: string;
  poster?: string;
  free?: boolean;
  badge?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="group flex min-w-0 flex-col gap-2 text-left">
      <span className="relative block w-full transition-transform duration-200 ease-out-strong group-active:scale-[0.97] [@media(hover:hover)]:group-hover:-translate-y-1">
        <PosterImage name={name} poster={poster} />
        <span className="absolute top-2 left-2">
          {badge ??
            (free && (
              <span className="rounded-full bg-ink-950/70 px-2 py-0.5 text-[11px] font-semibold text-ember-300 ring-1 ring-ember-500/30 backdrop-blur-md">
                Free
              </span>
            ))}
        </span>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-fog-100">{name}</span>
        {year && <span className="text-[12px] text-fog-500">{year}</span>}
      </span>
    </button>
  );
}

function PosterImage({ name, poster }: { name: string; poster?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="relative block aspect-[2/3] w-full overflow-hidden rounded-xl bg-ink-800 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.7)] ring-1 ring-white/8">
      {poster && !failed ? (
        <img src={poster} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center bg-gradient-to-br from-ember-500/20 to-ink-800 p-3 text-center text-[13px] font-semibold text-fog-300">
          <FilmStripIcon size={24} weight="duotone" className="mb-1 text-ember-300" />
          {name}
        </span>
      )}
    </span>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-fog-50">{title}</h3>
      <p className="text-[13px] text-fog-500">{hint}</p>
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <p className="text-[15px] font-semibold text-fog-100">Couldn&rsquo;t load this</p>
      <Button variant="glass" onClick={onRetry}>
        <ArrowClockwiseIcon size={18} /> Try again
      </Button>
    </div>
  );
}

function skeletonPosters(n: number) {
  return Array.from({ length: n }, (_, i) => (
    <span key={i} className="flex flex-col gap-2" aria-hidden>
      <span className="skeleton aspect-[2/3] w-full rounded-xl" />
      <span className="skeleton h-3.5 w-3/4 rounded" />
    </span>
  ));
}

function hiddenText(h: Record<string, number>) {
  const parts: string[] = [];
  if (h.video) parts.push(`${h.video} need video transcoding (HEVC, 10-bit, WebM)`);
  if (h.audio) parts.push(`${h.audio} need audio transcoding (DTS, AC3)`);
  if (h.size) parts.push(`${h.size} over 4 GB`);
  if (h["not a torrent"]) parts.push(`${h["not a torrent"]} direct links`);
  return `Hidden: ${parts.join(", ")}.`;
}

export function formatSize(bytes: number) {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
