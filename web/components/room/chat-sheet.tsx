import { useEffect, useRef } from "react";
import { animate, motion, useTransform, type MotionValue, type PanInfo } from "motion/react";
import { CaretDownIcon } from "@phosphor-icons/react";

const HANDLE = 44;

export type ChatMode = "open" | "docked" | "closed";

// Where a flick would come to rest, with iOS scroll deceleration (Designing Fluid Interfaces).
function project(velocity: number, rate = 0.998) {
  return ((velocity / 1000) * rate) / (1 - rate);
}

/**
 * Phone chat: a sheet with three resting places. "docked" sits under the stage, "open"
 * covers the film up to the header, "closed" is off the bottom of the screen (the stage
 * grows into the space; the header's chat button brings it back).
 * It always spans header → bottom; y just clips its top away. Only clip-path and the
 * handle's transform change while dragging, so the sheet runs no layout per frame, and the
 * newest messages and the composer stay pinned to the bottom at every position.
 */
export function ChatSheet({
  y,
  top,
  dockedOffset,
  closedOffset,
  mode,
  onModeChange,
  children,
}: {
  y: MotionValue<number>; // shared with the stage, which grows as the sheet goes down
  top: number; // the sheet's top edge when fully open (just under the header)
  dockedOffset: number; // px from that edge down to the bottom of the docked stage
  closedOffset: number; // px from that edge to the bottom of the screen
  mode: ChatMode;
  onModeChange: (m: ChatMode) => void;
  children: (handleHeight: number) => React.ReactNode;
}) {
  const clip = useTransform(y, (v) => `inset(${Math.max(0, v)}px 0px 0px 0px round 24px 24px 0px 0px)`);
  const dragging = useRef(false);
  const dragged = useRef(false); // this press turned into a drag, so its release isn't a tap
  const offsetFor = (m: ChatMode) => (m === "open" ? 0 : m === "docked" ? dockedOffset : closedOffset);

  // Follow state changes that don't come from a drag (buttons, composer focus, resize).
  // The first placement is instant: a chat remembered as closed starts closed.
  const placed = useRef(false);
  useEffect(() => {
    if (dragging.current) return;
    if (!placed.current) {
      placed.current = true;
      y.set(offsetFor(mode));
      return;
    }
    const controls = animate(y, offsetFor(mode), { type: "spring", bounce: 0, duration: 0.4 });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dockedOffset, closedOffset, y]);

  function onDragEnd(_: unknown, info: PanInfo) {
    dragging.current = false;
    const landing = y.get() + project(info.velocity.y);
    // Nearest resting place to where the flick would land. Closing needs a deliberate
    // pull: it takes a third of the way past docked, not half.
    const next: ChatMode =
      landing < dockedOffset / 2 ? "open" : landing > dockedOffset + (closedOffset - dockedOffset) / 3 ? "closed" : "docked";
    // A flick carried momentum, so allow a touch of overshoot; hand its velocity to the spring.
    animate(y, offsetFor(next), { type: "spring", bounce: 0.15, duration: 0.45, velocity: info.velocity.y });
    if (next !== mode) onModeChange(next);
  }

  const closed = mode === "closed";
  return (
    <motion.section
      aria-label="Chat"
      aria-hidden={closed}
      inert={closed}
      style={{ top, clipPath: clip }}
      className="glass-thick absolute inset-x-0 bottom-0 flex flex-col"
    >
      <motion.div
        style={{ y }}
        drag="y"
        dragConstraints={{ top: 0, bottom: closedOffset }}
        dragElastic={0.12} // rubber-band past either end instead of a hard stop
        dragMomentum={false}
        onPointerDown={() => (dragged.current = false)}
        onDragStart={() => (dragging.current = dragged.current = true)}
        onDragEnd={onDragEnd}
        onTap={() => !dragged.current && onModeChange(mode === "open" ? "docked" : "open")}
        className="absolute inset-x-0 top-0 z-10 flex cursor-grab touch-none flex-col items-center active:cursor-grabbing"
      >
        {/* Scroll-edge fade rather than a hard divider where messages pass under the grabber. */}
        <div className="relative flex h-11 w-full items-center justify-center bg-gradient-to-b from-ink-900 from-40% to-ink-900/0">
          <span className="h-[5px] w-10 rounded-full bg-fog-500/50" />
          <button
            onPointerDownCapture={(e) => e.stopPropagation()} // a tap here, not the start of a drag
            onClick={() => onModeChange("closed")}
            aria-label="Hide chat"
            className="press absolute top-1 right-2 grid size-9 place-items-center rounded-full text-fog-500 select-none active:bg-white/10"
          >
            <CaretDownIcon size={18} weight="bold" />
          </button>
        </div>
        <button className="sr-only" onClick={() => onModeChange(mode === "open" ? "docked" : "open")}>
          {mode === "open" ? "Show the film" : "Expand chat"}
        </button>
      </motion.div>
      {children(HANDLE)}
    </motion.section>
  );
}
