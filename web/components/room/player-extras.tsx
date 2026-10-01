import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CheckIcon,
  FireIcon,
  HandsClappingIcon,
  HeartIcon,
  PlusIcon,
  SkullIcon,
  SmileySadIcon,
  SmileyWinkIcon,
  SubtitlesIcon,
  type Icon,
} from "@phosphor-icons/react";
import { type FloatingReaction, type ReactionKind, type Track } from "@/lib/room";
import type { Quality } from "@/lib/hls-source";
import { Popover } from "@/components/ui/popover";

// --- Reactions ---------------------------------------------------------------------------

export const REACTION_ICON: Record<ReactionKind, { icon: Icon; label: string }> = {
  love: { icon: HeartIcon, label: "Love" },
  laugh: { icon: SmileyWinkIcon, label: "Laugh" },
  sad: { icon: SmileySadIcon, label: "Sad" },
  fire: { icon: FireIcon, label: "Fire" },
  clap: { icon: HandsClappingIcon, label: "Clap" },
  wow: { icon: SkullIcon, label: "I’m dead" },
};

/** The order they're offered in, left to right. */
export const REACTION_ORDER: ReactionKind[] = ["love", "laugh", "sad", "fire", "clap", "wow"];

function ReactionIconButton({
  kind,
  onReact,
  size = 40,
  className = "",
}: {
  kind: ReactionKind;
  onReact: (k: ReactionKind) => void;
  size?: number;
  className?: string;
}) {
  const { icon: I, label } = REACTION_ICON[kind];
  return (
    <button
      aria-label={label}
      title={label}
      onClick={() => onReact(kind)}
      style={{ width: size, height: size }}
      className={`press grid shrink-0 place-items-center rounded-full text-plum-200 hover:bg-white/8 ${className}`}
    >
      <I size={Math.round(size * 0.5)} weight="fill" />
    </button>
  );
}

function AllReactions({ onReact }: { onReact: (k: ReactionKind) => void }) {
  return (
    <div className="flex gap-0.5">
      {REACTION_ORDER.map((k) => (
        <ReactionIconButton key={k} kind={k} onReact={onReact} size={44} />
      ))}
    </div>
  );
}

/**
 * A pill with two quick reactions and a plus for the rest (the couch on wide screens, the
 * control bar in video mode). The plus menu stays open: a few in a row is the usual pattern.
 */
export function ReactionsPill({
  onReact,
  quick = ["love", "laugh"],
  size = 40,
  className = "",
  onOpenChange,
}: {
  onReact: (k: ReactionKind) => void;
  quick?: ReactionKind[];
  size?: number;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  return (
    <div className={`flex shrink-0 items-center gap-1 rounded-full bg-ink-850 p-1 ${className}`}>
      {quick.map((k) => (
        <ReactionIconButton key={k} kind={k} onReact={onReact} size={size} />
      ))}
      <button
        ref={plus}
        aria-label="More reactions"
        title="More reactions"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ width: size, height: size }}
        className={`press grid shrink-0 place-items-center rounded-full hover:bg-white/8 ${open ? "bg-white/10 text-fog-50" : "text-fog-500"}`}
      >
        <PlusIcon size={Math.round(size * 0.45)} />
      </button>
      <Popover anchor={plus.current} open={open} onClose={() => setOpen(false)} label="Reactions" className="!rounded-full !p-1.5">
        <AllReactions onReact={onReact} />
      </Popover>
    </div>
  );
}

/** Phones: all six in a row above the composer. */
export function ReactionRow({ onReact, className = "" }: { onReact: (k: ReactionKind) => void; className?: string }) {
  return (
    <div className={`flex gap-1.5 ${className}`} role="group" aria-label="Reactions">
      {REACTION_ORDER.map((k) => (
        <ReactionIconButton key={k} kind={k} onReact={onReact} size={44} className="bg-ink-800 hover:bg-ink-700" />
      ))}
    </div>
  );
}

/** A single smiley that opens all six (the wide control bar in full screen). */
export function ReactionButton({ onReact, onOpenChange }: { onReact: (k: ReactionKind) => void; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  return (
    <>
      <ControlButton ref={ref} label="React" onClick={() => setOpen((o) => !o)} active={open}>
        <SmileyWinkIcon size={21} />
      </ControlButton>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} label="Reactions" className="!rounded-full !p-1.5">
        <AllReactions onReact={onReact} />
      </Popover>
    </>
  );
}

/** Reactions rising over the film, on the right, each with who sent it. */
export function ReactionLayer({ reactions, bottom = 96 }: { reactions: FloatingReaction[]; bottom?: number }) {
  const reduce = useReducedMotion();
  return (
    <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden" aria-live="polite">
      <AnimatePresence>
        {reactions.map((r) => {
          const { icon: I, label } = REACTION_ICON[r.kind];
          const x = 4 + ((r.id * 37) % 14); // spread along the right edge, stable per reaction
          const drift = ((r.id * 53) % 36) - 18;
          return (
            <motion.div
              key={r.id}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 0, x: 0, scale: 0.6 }}
              animate={
                reduce ? { opacity: [0, 1, 1, 0] } : { opacity: [0, 1, 1, 0], y: -220, x: drift, scale: [0.6, 1.15, 1, 0.95] }
              }
              transition={{ duration: 2.8, ease: [0.23, 1, 0.32, 1], times: [0, 0.12, 0.7, 1] }}
              style={{ right: `${x}%`, bottom }}
              className="absolute flex flex-col items-center gap-1"
            >
              <I size={34} weight="fill" aria-label={label} className="text-plum-200 drop-shadow-[0_2px_10px_rgb(0_0_0/0.5)]" />
              <span className="max-w-[10ch] truncate rounded-full bg-ink-950/50 px-2 py-px text-[11px] font-semibold text-fog-100 backdrop-blur-md">
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

/** The subtitles button: each viewer's own subtitles, timing nudge, quality and audio language. */
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
  size = 40,
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
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  useEffect(() => {
    if (open) loadAddonSubs?.();
  }, [open, loadAddonSubs]);

  return (
    <>
      <ControlButton
        ref={ref}
        label="Subtitles, audio and quality"
        onClick={() => setOpen((o) => !o)}
        active={open || subtitleKey !== null}
        size={size}
      >
        <SubtitlesIcon size={21} weight={subtitleKey ? "fill" : "regular"} />
      </ControlButton>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} label="Subtitles and audio" className="w-[280px]">
        <div className="flex max-h-[min(440px,70dvh)] flex-col overflow-y-auto overscroll-contain">
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
            <div className="mt-1 flex shrink-0 items-center gap-2 rounded-[16px] bg-white/5 px-3 py-2">
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
        </div>
      </Popover>
    </>
  );
}

function MenuTitle({ children }: { children: React.ReactNode }) {
  return <p className="shrink-0 px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-fog-500 uppercase">{children}</p>;
}

function MenuItem({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
      className="press flex min-h-10 shrink-0 items-center gap-2 rounded-[14px] px-3 text-left text-[14px] text-fog-100 hover:bg-white/8"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <CheckIcon size={16} weight="bold" className="shrink-0 text-plum-200" />}
    </button>
  );
}

function NudgeButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="press grid size-8 place-items-center rounded-full bg-white/10 font-mono text-[15px] font-semibold text-fog-50 hover:bg-white/15"
    >
      {children}
    </button>
  );
}

/** A round icon button for the film's controls. */
export function ControlButton({
  ref,
  label,
  onClick,
  active,
  size = 40,
  children,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  onClick: () => void;
  active?: boolean;
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      style={{ width: size, height: size }}
      className={`press grid shrink-0 place-items-center rounded-full hover:bg-white/10 ${active ? "text-plum-200" : "text-fog-100"}`}
    >
      {children}
    </button>
  );
}
