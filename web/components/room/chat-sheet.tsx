import { useEffect, useRef } from "react";
import { animate, motion, useMotionValue, useTransform, type PanInfo } from "motion/react";

const HANDLE = 44;

// Where a flick would come to rest, with iOS scroll deceleration (Designing Fluid Interfaces).
function project(velocity: number, rate = 0.998) {
  return ((velocity / 1000) * rate) / (1 - rate);
}

/**
 * Phone chat: a sheet that rests under the stage and drags up over the film.
 * It always spans header → bottom; "collapsed" just clips its top away. Only clip-path and
 * the handle's transform change while dragging, so no layout runs per frame, and the newest
 * messages and the composer stay pinned to the bottom at every position.
 */
export function ChatSheet({
  top,
  collapsedOffset,
  expanded,
  onExpandedChange,
  children,
}: {
  top: number; // the sheet's top edge when fully open (just under the header)
  collapsedOffset: number; // px from that edge down to the bottom of the stage
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
  children: (handleHeight: number) => React.ReactNode;
}) {
  const y = useMotionValue(expanded ? 0 : collapsedOffset);
  const clip = useTransform(y, (v) => `inset(${Math.max(0, v)}px 0px 0px 0px round 24px 24px 0px 0px)`);
  const dragging = useRef(false);

  // Follow state changes that don't come from a drag (tap, composer focus, resize).
  useEffect(() => {
    if (dragging.current) return;
    const controls = animate(y, expanded ? 0 : collapsedOffset, { type: "spring", bounce: 0, duration: 0.4 });
    return () => controls.stop();
  }, [expanded, collapsedOffset, y]);

  function onDragEnd(_: unknown, info: PanInfo) {
    dragging.current = false;
    const landing = y.get() + project(info.velocity.y);
    const open = landing < collapsedOffset / 2;
    // A flick carried momentum, so allow a touch of overshoot; hand its velocity to the spring.
    animate(y, open ? 0 : collapsedOffset, { type: "spring", bounce: 0.15, duration: 0.45, velocity: info.velocity.y });
    if (open !== expanded) onExpandedChange(open);
  }

  return (
    <motion.section aria-label="Chat" style={{ top, clipPath: clip }} className="glass-thick absolute inset-x-0 bottom-0 flex flex-col">
      <motion.div
        style={{ y }}
        drag="y"
        dragConstraints={{ top: 0, bottom: collapsedOffset }}
        dragElastic={0.12} // rubber-band past either end instead of a hard stop
        dragMomentum={false}
        onDragStart={() => (dragging.current = true)}
        onDragEnd={onDragEnd}
        onTap={() => onExpandedChange(!expanded)}
        className="absolute inset-x-0 top-0 z-10 flex cursor-grab touch-none flex-col items-center active:cursor-grabbing"
      >
        {/* Scroll-edge fade rather than a hard divider where messages pass under the grabber. */}
        <div className="flex h-11 w-full items-center justify-center bg-gradient-to-b from-ink-900 from-40% to-ink-900/0">
          <span className="h-[5px] w-10 rounded-full bg-fog-500/50" />
        </div>
        <button className="sr-only" onClick={() => onExpandedChange(!expanded)}>
          {expanded ? "Show the film" : "Expand chat"}
        </button>
      </motion.div>
      {children(HANDLE)}
    </motion.section>
  );
}
