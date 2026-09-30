import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowClockwiseIcon, DevicesIcon } from "@phosphor-icons/react";
import type { RoomConnection, RoomView } from "@/lib/room";
import { Button } from "@/components/ui/button";

export function RoomDialogs({ view, conn }: { view: RoomView; conn: RoomConnection }) {
  return (
    <AnimatePresence>
      {view.status === "replaced" && (
        <Dialog
          key="replaced"
          icon={<DevicesIcon size={26} weight="duotone" />}
          title="Anda is open somewhere else"
          body="You opened this room in another tab or on another device. Only one can be in the room at a time."
          action="Use this one instead"
          onAction={() => conn.takeOver()}
        />
      )}
      {view.status === "outdated" && (
        <Dialog
          key="outdated"
          icon={<ArrowClockwiseIcon size={26} weight="bold" />}
          title="Anda was updated"
          body="Refresh to get the new version. You'll land back in this room."
          action="Refresh"
          onAction={() => location.reload()}
        />
      )}
    </AnimatePresence>
  );
}

// A modal task: dim the room behind it, and let the card materialise (blur + scale + fade).
function Dialog({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      className="fixed inset-0 z-50 grid place-items-center bg-ink-950/60 p-4 backdrop-blur-sm"
    >
      <motion.div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-body"
        initial={{ opacity: 0, scale: 0.95, filter: "blur(8px)" }}
        animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
        exit={{ opacity: 0, scale: 0.97, filter: "blur(4px)", transition: { duration: 0.15 } }}
        transition={{ type: "spring", bounce: 0, duration: 0.35 }}
        className="glass-thick flex w-full max-w-[380px] flex-col gap-4 rounded-[28px] p-7"
      >
        <span className="grid size-12 place-items-center rounded-2xl bg-ember-500/12 text-ember-400 ring-1 ring-ember-500/20">
          {icon}
        </span>
        <div className="flex flex-col gap-2">
          <h2 id="dialog-title" className="text-xl font-semibold tracking-[-0.02em] text-fog-50">
            {title}
          </h2>
          <p id="dialog-body" className="text-[15px] leading-relaxed text-fog-300">
            {body}
          </p>
        </div>
        <Button ref={ref} size="lg" onClick={onAction} className="mt-2 w-full">
          {action}
        </Button>
      </motion.div>
    </motion.div>
  );
}
