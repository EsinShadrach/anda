import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";

type Placement = "top" | "bottom";

/**
 * A menu anchored to an element, rendered into <body> so a scrolling or clipped parent
 * (the couch's row of seats) can't cut it off. It grows out of its anchor, flips to the
 * other side when there's no room, and closes on an outside press, Escape, or a scroll.
 */
export function Popover({
  anchor,
  open,
  onClose,
  placement = "top",
  children,
  className = "",
  label,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  placement?: Placement;
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  if (typeof document === "undefined") return null;
  // In full screen only the full-screen element is painted, so the menu has to live in it.
  return createPortal(
    <AnimatePresence>
      {open && anchor && (
        <Panel anchor={anchor} onClose={onClose} placement={placement} className={className} label={label}>
          {children}
        </Panel>
      )}
    </AnimatePresence>,
    document.fullscreenElement ?? document.body,
  );
}

const GAP = 10;
const MARGIN = 12;

function Panel({
  anchor,
  onClose,
  placement,
  children,
  className,
  label,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  placement: Placement;
  children: React.ReactNode;
  className: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: Placement; originX: number; maxHeight: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // The preferred side, unless it's too short and the other side has more room. Either
    // way the menu is capped to the room it has and scrolls inside (a long subtitle list
    // under a phone's film).
    const above = a.top - GAP - MARGIN;
    const below = innerHeight - a.bottom - GAP - MARGIN;
    let side = placement;
    if (side === "top" && h > above && below > above) side = "bottom";
    else if (side === "bottom" && h > below && above > below) side = "top";
    const maxHeight = Math.max(120, side === "top" ? above : below);
    const height = Math.min(h, maxHeight);
    const centre = a.left + a.width / 2;
    const left = Math.min(Math.max(MARGIN, centre - w / 2), innerWidth - w - MARGIN);
    const top = side === "top" ? a.top - GAP - height : a.bottom + GAP;
    setPos({ left, top, side, originX: centre - left, maxHeight });
  }, [anchor, placement]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onResize = () => onClose();
    // Close when the anchor moves (the page, or a row it sits in, scrolled), not when
    // something unrelated scrolls: the menu's own list, or chat following a new message.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === document || (t instanceof Node && t.contains(anchor))) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  const fromY = pos?.side === "bottom" ? -6 : 6;
  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label={label}
      initial={{ opacity: 0, y: fromY, scale: 0.96 }}
      animate={pos ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0 }}
      exit={{ opacity: 0, y: fromY / 2, scale: 0.97, transition: { duration: 0.12 } }}
      transition={{ type: "spring", bounce: 0, duration: 0.25 }}
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        maxHeight: pos?.maxHeight,
        transformOrigin: `${pos?.originX ?? 0}px ${pos?.side === "bottom" ? "0%" : "100%"}`,
      }}
      className={`glass-thick z-[60] flex flex-col rounded-[24px] p-2 ${className}`}
    >
      {children}
    </motion.div>
  );
}

export function MenuItem({
  onClick,
  icon,
  children,
  tone,
  checked,
}: {
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: "accent" | "danger";
  checked?: boolean;
}) {
  return (
    <button
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      onClick={onClick}
      className={`press flex min-h-11 w-full items-center gap-3 rounded-[16px] px-3 text-left text-[15px] font-medium hover:bg-white/8 ${
        tone === "accent" ? "text-plum-200" : tone === "danger" ? "text-danger" : "text-fog-100"
      }`}
    >
      {icon && <span className="grid size-5 shrink-0 place-items-center text-fog-300">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
