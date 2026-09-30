import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CheckIcon,
  FireIcon,
  HandsClappingIcon,
  HeartIcon,
  SmileyIcon,
  SmileySadIcon,
  SmileyXEyesIcon,
  SubtitlesIcon,
  type Icon,
} from "@phosphor-icons/react";
import { REACTIONS, type FloatingReaction, type ReactionKind, type Track } from "@/lib/room";
import type { Quality } from "@/lib/hls-source";

// --- Reactions ---------------------------------------------------------------------------

export const REACTION_ICON: Record<ReactionKind, { icon: Icon; label: string; className: string }> = {
  laugh: { icon: SmileyIcon, label: "Laugh", className: "text-away" },
  love: { icon: HeartIcon, label: "Love", className: "text-danger" },
  wow: { icon: SmileyXEyesIcon, label: "Wow", className: "text-fog-50" },
  sad: { icon: SmileySadIcon, label: "Sad", className: "text-fog-300" },
  clap: { icon: HandsClappingIcon, label: "Clap", className: "text-ember-300" },
  fire: { icon: FireIcon, label: "Fire", className: "text-ember-500" },
};

/** The smiley in the controls: opens the six reactions. */
export function ReactionButton({ onReact, onOpenChange }: { onReact: (k: ReactionKind) => void; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  const ref = usePopoverClose(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <ControlButton label="React" onClick={() => setOpen((o) => !o)} active={open}>
        <SmileyIcon size={21} />
      </ControlButton>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97, transition: { duration: 0.12 } }}
            transition={{ type: "spring", bounce: 0, duration: 0.25 }}
            style={{ transformOrigin: "bottom center" }}
            className="glass-thick absolute bottom-[calc(100%+10px)] left-1/2 z-40 flex -translate-x-1/2 gap-0.5 rounded-full p-1.5"
            role="menu"
          >
            {REACTIONS.map((k) => {
              const { icon: I, label, className } = REACTION_ICON[k];
              return (
                <button
                  key={k}
                  role="menuitem"
                  aria-label={label}
                  title={label}
                  onClick={() => onReact(k)} // stays open: a few in a row is the usual pattern
                  className={`press grid size-10 place-items-center rounded-full hover:bg-white/10 ${className}`}
                >
                  <I size={24} weight="fill" />
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Reactions rising over the film, bottom right, each with who sent it. */
export function ReactionLayer({ reactions }: { reactions: FloatingReaction[] }) {
  const reduce = useReducedMotion();
  return (
    <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden" aria-live="polite">
      <AnimatePresence>
        {reactions.map((r) => {
          const { icon: I, label, className } = REACTION_ICON[r.kind];
          const x = 8 + ((r.id * 37) % 22); // spread across the right side, stable per reaction
          const drift = ((r.id * 53) % 40) - 20;
          return (
            <motion.div
              key={r.id}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 0, x: 0, scale: 0.6 }}
              animate={
                reduce
                  ? { opacity: [0, 1, 1, 0] }
                  : { opacity: [0, 1, 1, 0], y: -240, x: drift, scale: [0.6, 1.15, 1, 0.95] }
              }
              transition={{ duration: 2.8, ease: [0.23, 1, 0.32, 1], times: [0, 0.12, 0.7, 1] }}
              style={{ right: `${x}%` }}
              className="absolute bottom-24 flex flex-col items-center gap-0.5"
            >
              <span className={`grid size-12 place-items-center rounded-full bg-ink-950/45 backdrop-blur-md ${className}`}>
                <I size={30} weight="fill" aria-label={label} />
              </span>
              <span className="max-w-[10ch] truncate rounded-full bg-ink-950/45 px-2 text-[11px] font-semibold text-fog-100 backdrop-blur-md">
                {r.self ? "You" : r.by}
              </span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// --- Subtitles and audio -----------------------------------------------------------------

export type SubtitleChoice = { key: string; url: string; label: string } | null;
export type AddonSubtitle = { key: string; lang?: string; source: string };

const names = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "language" }) : null;

export function languageName(lang?: string): string {
  if (!lang) return "Unknown language";
  try {
    return names?.of(lang) ?? lang;
  } catch {
    return lang;
  }
}

export function trackLabel(t: Track, i: number, kind: "audio" | "subtitles"): string {
  const lang = t.lang ? languageName(t.lang) : "";
  const base = t.label && lang && !t.label.toLowerCase().includes(lang.toLowerCase()) ? `${lang} · ${t.label}` : t.label || lang;
  return (base || (kind === "audio" ? `Track ${i + 1}` : `Subtitles ${i + 1}`)) + (t.forced ? " (forced)" : "");
}

/** The CC button: each viewer's own subtitles, timing nudge and audio language. */
export function TracksMenu({
  subtitles,
  addonSubs,
  loadAddonSubs,
  subtitleKey,
  onSubtitle,
  offset,
  onOffset,
  audio,
  audioIndex,
  onAudio,
  quality,
  dataSaver,
  onDataSaver,
  onOpenChange,
}: {
  subtitles: Track[];
  addonSubs: AddonSubtitle[] | null | "loading"; // null: this film has no catalog entry
  loadAddonSubs?: () => void;
  subtitleKey: string | null;
  onSubtitle: (c: SubtitleChoice, lang?: string) => void;
  offset: number;
  onOffset: (s: number) => void;
  audio: Track[];
  audioIndex: number;
  onAudio: (i: number) => void;
  quality: Quality;
  dataSaver: boolean;
  onDataSaver: (on: boolean) => void;
  onOpenChange?: (open: boolean) => void; // the player keeps its controls up meanwhile
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  const ref = usePopoverClose(open, () => setOpen(false));
  useEffect(() => {
    if (open) loadAddonSubs?.();
  }, [open, loadAddonSubs]);

  return (
    <div ref={ref} className="relative">
      <ControlButton label="Subtitles and audio" onClick={() => setOpen((o) => !o)} active={open || subtitleKey !== null}>
        <SubtitlesIcon size={21} weight={subtitleKey ? "fill" : "regular"} />
      </ControlButton>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.12 } }}
            transition={{ type: "spring", bounce: 0, duration: 0.25 }}
            style={{ transformOrigin: "bottom right" }}
            className="glass-thick absolute right-0 bottom-[calc(100%+10px)] z-40 flex max-h-[min(420px,60dvh)] w-[272px] flex-col overflow-y-auto overscroll-contain rounded-2xl p-2"
          >
            <MenuTitle>Subtitles</MenuTitle>
            <MenuItem checked={subtitleKey === null} onClick={() => onSubtitle(null, "off")}>
              Off
            </MenuItem>
            {subtitles.map((t, i) => (
              <MenuItem
                key={t.url}
                checked={subtitleKey === t.url}
                onClick={() => onSubtitle({ key: t.url!, url: t.url!, label: trackLabel(t, i, "subtitles") }, t.lang)}
              >
                {trackLabel(t, i, "subtitles")}
              </MenuItem>
            ))}
            {addonSubs === "loading" && <p className="px-3 py-2 text-[12px] text-fog-500">Looking for more subtitles…</p>}
            {Array.isArray(addonSubs) && addonSubs.length > 0 && (
              <>
                <MenuTitle>From {addonSubs[0].source}</MenuTitle>
                {addonSubs.map((a) => (
                  <MenuItem
                    key={a.key}
                    checked={subtitleKey === a.key}
                    onClick={() => onSubtitle({ key: a.key, url: "", label: languageName(a.lang) }, a.lang)}
                  >
                    {languageName(a.lang)}
                  </MenuItem>
                ))}
              </>
            )}
            {subtitles.length === 0 && Array.isArray(addonSubs) && addonSubs.length === 0 && (
              <p className="px-3 pb-2 text-[12px] leading-snug text-fog-500">This release has no text subtitles.</p>
            )}
            {subtitleKey !== null && (
              <div className="mt-1 flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2">
                <span className="flex-1 text-[13px] text-fog-300">Timing</span>
                <NudgeButton onClick={() => onOffset(offset - 0.5)} label="Show subtitles earlier">
                  &minus;
                </NudgeButton>
                <span className="w-12 text-center font-mono text-[12px] text-fog-100 tabular-nums">
                  {offset > 0 ? "+" : ""}
                  {offset.toFixed(1)}s
                </span>
                <NudgeButton onClick={() => onOffset(offset + 0.5)} label="Show subtitles later">
                  +
                </NudgeButton>
              </div>
            )}
            {quality.heights.length > 1 && (
              <>
                <MenuTitle>Quality</MenuTitle>
                <MenuItem checked={!dataSaver} onClick={() => onDataSaver(false)}>
                  Auto{quality.current && !dataSaver ? <span className="text-fog-500"> · {quality.current}p now</span> : null}
                </MenuItem>
                <MenuItem checked={dataSaver} onClick={() => onDataSaver(true)}>
                  Data saver <span className="text-fog-500">· {quality.heights[0]}p</span>
                </MenuItem>
              </>
            )}
            {audio.length > 1 && (
              <>
                <MenuTitle>Audio</MenuTitle>
                {audio.map((t, i) => (
                  <MenuItem key={i} checked={audioIndex === i} onClick={() => onAudio(i)}>
                    {trackLabel(t, i, "audio")}
                  </MenuItem>
                ))}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuTitle({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-fog-500 uppercase">{children}</p>;
}

function MenuItem({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
      className="press flex min-h-10 items-center gap-2 rounded-xl px-3 text-left text-[14px] text-fog-100 hover:bg-white/8"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <CheckIcon size={16} weight="bold" className="shrink-0 text-ember-400" />}
    </button>
  );
}

function NudgeButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="press grid size-8 place-items-center rounded-lg bg-white/10 font-mono text-[15px] font-semibold text-fog-50 hover:bg-white/15"
    >
      {children}
    </button>
  );
}

function ControlButton({
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
      aria-expanded={active}
      className={`press grid size-10 shrink-0 place-items-center rounded-xl hover:bg-white/10 ${active ? "text-ember-400" : "text-fog-100"}`}
    >
      {children}
    </button>
  );
}

// Close a popover on outside press or Escape.
function usePopoverClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}
