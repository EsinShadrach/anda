import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useDragControls, type PanInfo } from "motion/react";
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  FilmReelIcon,
  LinkSimpleIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ApiError, library, type CatalogFilm, type Film, type FilmDetails, type LibraryStream } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  /** switching: the pick is another release of the film on screen, same timestamp. */
  onPick: (mediaId: number, switching: boolean) => void;
  /** The Library film on screen, if any: offers its other releases. */
  current?: CatalogFilm;
  /** Open straight onto the current film's releases (e.g. the download can't keep up). */
  switching?: boolean;
  switchAt?: number;
};

// What the right-hand panel shows: a film already on the server, or a catalog film and
// its streams.
type Selection = { kind: "ready"; film: Film } | { kind: "catalog"; film: CatalogFilm; switching?: boolean };

const WIDE_MQ = "(min-width: 1024px)";
function useWide() {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia(WIDE_MQ);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => matchMedia(WIDE_MQ).matches,
    () => true,
  );
}

// The host's Library: films already on the server, free open films, search through the
// catalog, and each film's playable streams. Picking a stream starts it downloading and
// puts it on the room's screen straight away (it plays as it arrives).
export function Library({ open, ...rest }: Props) {
  return <AnimatePresence>{open && <Sheet {...rest} />}</AnimatePresence>;
}

function Sheet({ onClose, onPick, current, switching: startSwitching, switchAt = 0 }: Omit<Props, "open">) {
  const wide = useWide();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selection | null>(
    startSwitching && current ? { kind: "catalog", film: current, switching: true } : null,
  );
  const drag = useDragControls();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selected && !wide && !startSwitching) setSelected(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, wide, onClose, startSwitching]);

  // A pull down the grabber (or a flick) puts the sheet away.
  function onDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.y > 140 || info.velocity.y > 600) onClose();
  }

  const detailOnly = !wide && selected !== null;
  const pick = (id: number) => onPick(id, selected?.kind === "catalog" && !!selected.switching);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-50 bg-ink-975/60 backdrop-blur-[2px]"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Library"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%", transition: { type: "spring", bounce: 0, duration: 0.3 } }}
        transition={{ type: "spring", bounce: 0, duration: 0.45 }}
        drag="y"
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.05, bottom: 0.9 }}
        onDragEnd={onDragEnd}
        className="absolute inset-x-0 top-[max(56px,calc(env(safe-area-inset-top)+16px))] bottom-0 flex flex-col overflow-hidden rounded-t-[40px] bg-ink-850 shadow-[0_-24px_80px_rgb(0_0_0/0.5)] sm:inset-x-5 max-sm:top-[max(12px,env(safe-area-inset-top))] max-sm:rounded-t-[32px]"
      >
        <div onPointerDown={(e) => drag.start(e)} className="flex shrink-0 cursor-grab touch-none justify-center pt-3 pb-1 active:cursor-grabbing">
          <span className="h-1 w-9 rounded-full bg-fog-600/60" />
        </div>

        {detailOnly ? (
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
            <div className="flex shrink-0 items-center justify-between py-2" onPointerDown={(e) => drag.start(e)}>
              <Button variant="secondary" size="icon" onClick={startSwitching ? onClose : () => setSelected(null)} aria-label="Back">
                <ArrowLeftIcon size={20} />
              </Button>
              <Button variant="secondary" size="icon" onClick={onClose} aria-label="Close library">
                <XIcon size={20} />
              </Button>
            </div>
            <Detail key={detailKey(selected)} selection={selected} switchAt={switchAt} onPick={pick} className="min-h-0 flex-1" />
          </div>
        ) : (
          <>
            <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-3 px-5 pt-3 pb-5 sm:px-9" onPointerDown={(e) => e.target === e.currentTarget && drag.start(e)}>
              <h2 className="text-[28px] font-semibold tracking-[-0.03em] text-fog-50 max-sm:flex-1 max-sm:text-[22px]">What are we watching?</h2>
              <SearchBox value={query} onChange={setQuery} className="max-sm:order-last max-sm:basis-full" />
              <Button variant="secondary" size="icon" onClick={onClose} aria-label="Close library">
                <XIcon size={20} />
              </Button>
            </header>
            <div className="flex min-h-0 flex-1 gap-8 px-5 sm:px-9">
              <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(24px,env(safe-area-inset-bottom))]">
                {query.trim() ? (
                  <Results key="results" query={query.trim()} selected={selected} onSelect={(f) => setSelected({ kind: "catalog", film: f })} />
                ) : (
                  <Browse selected={selected} onSelect={setSelected} />
                )}
              </div>
              {wide && (
                <div className="mb-6 flex w-[400px] shrink-0 flex-col rounded-[32px] bg-ink-800 p-6">
                  {selected ? (
                    <Detail key={detailKey(selected)} selection={selected} switchAt={switchAt} onPick={pick} className="min-h-0 flex-1" />
                  ) : (
                    <Nothing current={current} onOtherReleases={() => current && setSelected({ kind: "catalog", film: current, switching: true })} />
                  )}
                </div>
              )}
            </div>
            {!wide && current && !query.trim() && (
              <div className="shrink-0 px-4 pb-[max(12px,env(safe-area-inset-bottom))]">
                <NowShowing film={current} onOtherReleases={() => setSelected({ kind: "catalog", film: current, switching: true })} />
              </div>
            )}
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

function detailKey(s: Selection) {
  return s.kind === "ready" ? `r${s.film.id}` : `c${s.film.id}${s.switching ? "s" : ""}`;
}

function SearchBox({ value, onChange, className = "" }: { value: string; onChange: (v: string) => void; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Desktop only: on phones, focusing would throw the keyboard over the shelf.
    if (matchMedia("(pointer: fine)").matches) ref.current?.focus();
  }, []);
  return (
    <label
      className={`flex h-14 min-w-0 flex-1 items-center gap-3 rounded-full bg-ink-800 px-5 transition-shadow duration-150 focus-within:shadow-[0_0_0_2px_var(--color-plum-600)] ${className}`}
    >
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
        <button
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="press -mr-2 grid size-9 place-items-center rounded-full text-fog-500 hover:bg-white/10 hover:text-fog-100"
        >
          <XIcon size={16} weight="bold" />
        </button>
      )}
    </label>
  );
}

// The right-hand panel before anything is picked: what's on now, and a way to its other
// releases (a better copy, or a faster download) that carries on from the same point.
function Nothing({ current, onOtherReleases }: { current?: CatalogFilm; onOtherReleases: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      {current ? (
        <>
          <div className="w-24 overflow-hidden rounded-[18px]">
            <PosterImage name={current.name} poster={current.poster} />
          </div>
          <p className="text-[13px] text-fog-500">Now showing</p>
          <p className="text-[20px] font-semibold tracking-[-0.02em] text-fog-50">{current.name}</p>
          <Button variant="secondary" onClick={onOtherReleases} className="mt-1">
            <ArrowsClockwiseIcon size={18} /> Other releases
          </Button>
        </>
      ) : (
        <>
          <span className="grid size-16 place-items-center rounded-full bg-ink-700 text-plum-200">
            <FilmReelIcon size={28} weight="duotone" />
          </span>
          <p className="max-w-[24ch] text-[15px] text-fog-500">Pick a film to see how it can play.</p>
        </>
      )}
    </div>
  );
}

function NowShowing({ film, onOtherReleases }: { film: CatalogFilm; onOtherReleases: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-[24px] bg-ink-800 p-2.5 pr-3">
      <div className="w-9 shrink-0 overflow-hidden rounded-[10px]">
        <PosterImage name={film.name} poster={film.poster} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-fog-500">Now showing</p>
        <p className="truncate text-[15px] font-semibold text-fog-50">{film.name}</p>
      </div>
      <Button variant="secondary" onClick={onOtherReleases} className="h-10 px-4 text-[14px]">
        Other releases
      </Button>
    </div>
  );
}

// No query: what's ready right now, and the free open films.
function Browse({ selected, onSelect }: { selected: Selection | null; onSelect: (s: Selection) => void }) {
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
    <div className="enter flex flex-col gap-8">
      {(ready === null || ready.length > 0) && (
        <section className="flex flex-col gap-3">
          <SectionTitle title="Ready to watch" hint="Already on the server, so it starts instantly." />
          <PosterGrid size="lg">
            {ready === null
              ? skeletonPosters(3)
              : ready.map((f) => (
                  <Poster
                    key={f.id}
                    name={f.title}
                    year={f.year}
                    poster={f.poster}
                    selected={selected?.kind === "ready" && selected.film.id === f.id}
                    onClick={() => onSelect({ kind: "ready", film: f })}
                  />
                ))}
          </PosterGrid>
        </section>
      )}
      <section className="flex flex-col gap-3">
        <SectionTitle title="Free to watch" hint="Open films from the Blender Foundation, shared under Creative Commons." />
        <PosterGrid size="sm">
          {free === null
            ? skeletonPosters(4)
            : free.map((f) => (
                <Poster
                  key={f.id}
                  name={f.name}
                  poster={f.poster}
                  small
                  selected={selected?.kind === "catalog" && selected.film.id === f.id}
                  onClick={() => onSelect({ kind: "catalog", film: f })}
                />
              ))}
        </PosterGrid>
      </section>
    </div>
  );
}

function Results({ query, selected, onSelect }: { query: string; selected: Selection | null; onSelect: (f: CatalogFilm) => void }) {
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
  if (films === null) return <PosterGrid size="md">{skeletonPosters(10)}</PosterGrid>;
  if (films.length === 0)
    return (
      <div className="enter flex flex-col items-center gap-2 py-16 text-center">
        <p className="text-[16px] font-semibold text-fog-100">Nothing called &ldquo;{query}&rdquo;</p>
        <p className="text-[14px] text-fog-500">Try the original title, or fewer words.</p>
      </div>
    );
  return (
    <PosterGrid size="md" className="enter">
      {films.map((f) => (
        <Poster
          key={f.id}
          name={f.name}
          year={f.year}
          poster={f.poster}
          free={f.free}
          selected={selected?.kind === "catalog" && selected.film.id === f.id}
          onClick={() => onSelect(f)}
        />
      ))}
    </PosterGrid>
  );
}

// The chosen film: what it is, how it can play, and the button that puts it on.
function Detail({
  selection,
  switchAt,
  onPick,
  className = "",
}: {
  selection: Selection;
  switchAt: number;
  onPick: (id: number) => void;
  className?: string;
}) {
  if (selection.kind === "ready") return <ReadyDetail film={selection.film} onPick={onPick} className={className} />;
  return <CatalogDetail film={selection.film} switchAt={selection.switching ? switchAt : undefined} onPick={onPick} className={className} />;
}

function ReadyDetail({ film, onPick, className }: { film: Film; onPick: (id: number) => void; className: string }) {
  return (
    <div className={`enter flex flex-col ${className}`}>
      <DetailHead name={film.title} meta={[film.year, film.duration ? runtime(film.duration) : undefined]} />
      <p className="mt-6 mb-2 text-[14px] font-semibold text-fog-300">On the server</p>
      <div className="flex min-h-16 items-center gap-3 rounded-[22px] bg-ink-700 px-4 shadow-[0_0_0_2px_var(--color-plum-600)]">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[16px] font-semibold text-fog-50">Ready</span>
          <span className="text-[13px] text-fog-500">{film.size_bytes ? formatSize(film.size_bytes) : "Prepared"}</span>
        </div>
        <Availability tone="live">Starts instantly</Availability>
      </div>
      <div className="min-h-6 flex-1" />
      <Button size="xl" onClick={() => onPick(film.id)} className="w-full">
        <PlayIcon size={20} weight="fill" /> Put it on
      </Button>
    </div>
  );
}

function CatalogDetail({
  film,
  switchAt,
  onPick,
  className,
}: {
  film: CatalogFilm;
  switchAt?: number; // set when switching release: the room carries on from here
  onPick: (id: number) => void;
  className: string;
}) {
  const [data, setData] = useState<{ meta: FilmDetails; streams: LibraryStream[]; hidden: Record<string, number>; failed?: string[] } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setError(false);
    setData(null);
    library.streams(film.id, ac.signal).then(
      (d) => {
        setData(d);
        setChosen(d.streams[0]?.key ?? null); // the sources list their best first
      },
      (e: Error) => e.name !== "AbortError" && setError(true),
    );
    return () => ac.abort();
  }, [film.id, attempt]);

  async function play() {
    if (!chosen) return;
    setStarting(true);
    setPickError(null);
    try {
      const f = await library.prepare(film.id, chosen);
      onPick(f.id);
    } catch (e) {
      setPickError(e instanceof ApiError ? e.message : "Couldn't start that stream.");
      setStarting(false);
    }
  }

  const meta = data?.meta;
  const hiddenCount = data ? Object.values(data.hidden).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className={`enter flex flex-col ${className}`}>
      <DetailHead name={meta?.name || film.name} meta={[meta?.year || film.year, meta?.runtime, meta?.genres?.slice(0, 2).join(", ")]} />
      <div className="no-scrollbar -mx-1 mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pt-1 pb-3">
        {meta?.description ? (
          <p className="line-clamp-3 text-[14px] leading-relaxed text-fog-500">{meta.description}</p>
        ) : (
          !data && !error && <span className="skeleton block h-12 w-full rounded-[14px]" />
        )}
        <p className="mt-5 mb-2 text-[14px] font-semibold text-fog-300">{switchAt !== undefined ? "Switch release" : "Pick a stream"}</p>
        {switchAt !== undefined && (
          <p className="mb-3 text-[13px] leading-relaxed text-fog-500">
            The room carries on from <span className="font-mono text-fog-300 tabular-nums">{clock(switchAt)}</span>. A new release downloads
            from its start, so the one with the most seeders gets there fastest.
          </p>
        )}
        {error ? (
          <LoadError onRetry={() => setAttempt((n) => n + 1)} />
        ) : !data ? (
          <ul className="flex flex-col gap-2.5" aria-busy>
            {[0, 1, 2].map((i) => (
              <li key={i} className="skeleton h-16 rounded-[22px]" />
            ))}
          </ul>
        ) : data.streams.length === 0 ? (
          <div className="rounded-[22px] bg-ink-700 p-5 text-[14px] leading-relaxed text-fog-300">
            <p className="font-semibold text-fog-100">No streams this server can play</p>
            <p className="mt-1 text-fog-500">
              {hiddenCount > 0
                ? `${hiddenCount} found, but they need video transcoding (HEVC, 10-bit, WebM) or are over 4 GB.`
                : data.failed?.length
                  ? `${data.failed.join(" and ")} didn't answer, so there's nothing to show yet.`
                  : "None of the configured sources have this film."}
            </p>
            {data.failed?.length ? (
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)} className="mt-3">
                <ArrowClockwiseIcon size={18} /> Try again
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5" role="radiogroup" aria-label="Streams">
            {data.streams.map((s) => (
              <li key={s.key}>
                <StreamRow stream={s} selected={chosen === s.key} disabled={starting} onSelect={() => setChosen(s.key)} />
              </li>
            ))}
          </ul>
        )}
        {data && data.streams.length > 0 && hiddenCount > 0 && <p className="mt-3 text-[12px] leading-relaxed text-fog-600">{hiddenText(data.hidden)}</p>}
        {data && data.streams.length > 0 && data.failed?.length ? (
          <p className="mt-2 text-[12px] leading-relaxed text-fog-600">{data.failed.join(" and ")} didn&rsquo;t answer; showing the rest.</p>
        ) : null}
      </div>
      {pickError && (
        <p role="alert" className="enter mb-3 flex items-center gap-2 text-[14px] text-danger">
          <WarningCircleIcon size={17} weight="fill" className="shrink-0" /> {pickError}
        </p>
      )}
      <Button size="xl" onClick={play} loading={starting} disabled={!chosen} className="w-full shrink-0">
        {switchAt !== undefined ? <ArrowsClockwiseIcon size={20} weight="bold" /> : <PlayIcon size={20} weight="fill" />}
        {switchAt !== undefined ? "Switch to this" : "Put it on"}
      </Button>
    </div>
  );
}

function DetailHead({ name, meta }: { name: string; meta: (string | undefined)[] }) {
  const line = meta.filter(Boolean).join(" · ");
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <h3 className="text-[28px] leading-tight font-semibold tracking-[-0.025em] text-fog-50">{name}</h3>
      {line && <p className="text-[14px] text-fog-500">{line}</p>}
    </div>
  );
}

function StreamRow({
  stream: s,
  selected,
  disabled,
  onSelect,
}: {
  stream: LibraryStream;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const heavy = !!s.kbps && s.kbps > HEAVY_KBPS;
  const detail = [s.source, s.size_bytes ? formatSize(s.size_bytes) : null].filter(Boolean).join(" · ");
  return (
    <button
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      title={s.release}
      className={`press flex min-h-16 w-full items-center gap-3 rounded-[22px] bg-ink-700 px-4 py-2.5 text-left transition-shadow duration-150 hover:bg-ink-600 ${
        selected ? "shadow-[0_0_0_2px_var(--color-plum-600)]" : ""
      }`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[16px] font-semibold text-fog-50">{s.quality ?? s.release}</span>
        <span className="flex min-w-0 items-center gap-1 text-[13px] text-fog-500">
          <span className="truncate">{detail}</span>
          {s.kbps ? (
            <span
              className={`shrink-0 ${heavy ? "text-away" : ""}`}
              title={heavy ? "Needs a fast connection to play smoothly. Slower viewers get a 480p copy once it's made." : "Estimated bitrate"}
            >
              · {(s.kbps / 1000).toFixed(1)} Mbit/s
            </span>
          ) : null}
        </span>
      </span>
      {s.direct ? (
        <Availability tone="muted" icon={<LinkSimpleIcon size={14} />}>
          Direct link
        </Availability>
      ) : s.seeders ? (
        <Availability tone={s.seeders >= 20 ? "live" : "away"}>
          {s.seeders} {s.seeders === 1 ? "seeder" : "seeders"}
        </Availability>
      ) : null}
    </button>
  );
}

function Availability({ tone, icon, children }: { tone: "live" | "away" | "muted"; icon?: React.ReactNode; children: React.ReactNode }) {
  const colour = tone === "live" ? "text-live" : tone === "away" ? "text-away" : "text-fog-500";
  return (
    <span className={`flex shrink-0 items-center gap-1.5 text-[13px] ${colour}`}>
      {icon ?? <span className={`size-[7px] rounded-full ${tone === "live" ? "bg-live" : tone === "away" ? "bg-away" : "bg-fog-500"}`} />}
      {children}
    </span>
  );
}

// Above this, viewers on slower connections will struggle until the 480p copy exists.
const HEAVY_KBPS = 4000;

function PosterGrid({ size, children, className = "" }: { size: "lg" | "md" | "sm"; children: React.ReactNode; className?: string }) {
  const cols =
    size === "lg"
      ? "grid-cols-[repeat(auto-fill,minmax(130px,160px))]"
      : size === "md"
        ? "grid-cols-[repeat(auto-fill,minmax(110px,140px))]"
        : "grid-cols-[repeat(auto-fill,minmax(96px,110px))]";
  return <div className={`grid gap-4 p-1 max-sm:gap-3 ${cols} ${className}`}>{children}</div>;
}

function Poster({
  name,
  year,
  poster,
  free,
  small,
  selected,
  onClick,
}: {
  name: string;
  year?: string;
  poster?: string;
  free?: boolean;
  small?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={`group relative block w-full text-left transition-[transform,box-shadow] duration-200 ease-out-strong active:scale-[0.97] ${small ? "rounded-[20px]" : "rounded-[24px]"} ${
        selected ? "shadow-[0_0_0_3px_var(--color-ink-850),0_0_0_5px_var(--color-plum-400)]" : ""
      }`}
    >
      <PosterImage name={name} poster={poster} label={false} className={small ? "rounded-[20px]" : "rounded-[24px]"} />
      <span
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col bg-gradient-to-t from-black/85 via-black/40 to-transparent ${small ? "rounded-b-[20px] px-3 pt-8 pb-2.5" : "rounded-b-[24px] px-3.5 pt-10 pb-3"}`}
      >
        <span className={`line-clamp-2 font-semibold tracking-[-0.01em] text-fog-50 ${small ? "text-[13px] leading-tight" : "text-[15px]"}`}>{name}</span>
        {year && <span className="text-[12px] text-fog-300">{year}</span>}
      </span>
      {free && (
        <span className="absolute top-2.5 left-2.5 rounded-full bg-ink-950/70 px-2 py-0.5 text-[11px] font-semibold text-plum-200 backdrop-blur-md">
          Free
        </span>
      )}
    </button>
  );
}

function PosterImage({
  name,
  poster,
  className = "rounded-[18px]",
  label = true,
}: {
  name: string;
  poster?: string;
  className?: string;
  label?: boolean; // false when the caller prints the title over it
}) {
  // No art: the title in its place, so the grid still says what it is.
  const [failed, setFailed] = useState(false);
  return (
    <span className={`relative block aspect-[2/3] w-full overflow-hidden bg-ink-800 ${className}`}>
      {poster && !failed ? (
        <img src={poster} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-plum-700/40 to-ink-800 p-3 text-center">
          <FilmReelIcon size={26} weight="duotone" className="text-plum-200/70" />
          {label && <span className="line-clamp-3 text-[12px] font-medium text-fog-300">{name}</span>}
        </span>
      )}
    </span>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h3 className="text-[15px] font-semibold text-fog-300">{title}</h3>
      <p className="text-[13px] text-fog-600">{hint}</p>
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <p className="text-[15px] font-semibold text-fog-100">Couldn&rsquo;t load this</p>
      <Button variant="secondary" onClick={onRetry}>
        <ArrowClockwiseIcon size={18} /> Try again
      </Button>
    </div>
  );
}

function skeletonPosters(n: number) {
  return Array.from({ length: n }, (_, i) => <span key={i} className="skeleton block aspect-[2/3] w-full rounded-[22px]" aria-hidden />);
}

function hiddenText(h: Record<string, number>) {
  const parts: string[] = [];
  if (h.video) parts.push(`${h.video} need video transcoding (HEVC, 10-bit, WebM)`);
  if (h.audio) parts.push(`${h.audio} need audio transcoding (DTS, AC3)`);
  if (h.size) parts.push(`${h.size} over 4 GB`);
  if (h.unsupported) parts.push(`${h.unsupported} that can’t be fetched (YouTube, links needing extra headers, private addresses)`);
  return `Hidden: ${parts.join(", ")}.`;
}

export function formatSize(bytes: number) {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function runtime(s: number) {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function clock(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
