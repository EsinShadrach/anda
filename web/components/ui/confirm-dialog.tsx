import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "./button";

type Props = {
  open: boolean;
  title: string;
  body: React.ReactNode;
  action: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

// For irreversible actions only. Focus starts on Cancel so a stray Enter can't destroy
// anything; Escape and a tap outside cancel too.
export function ConfirmDialog(props: Props) {
  return <AnimatePresence>{props.open && <Confirm {...props} />}</AnimatePresence>;
}

function Confirm({ title, body, action, busy, error, onConfirm, onCancel }: Props) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}
      className="fixed inset-0 z-50 grid place-items-center bg-ink-950/60 p-4 backdrop-blur-sm"
    >
      <motion.div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        initial={{ opacity: 0, scale: 0.95, filter: "blur(8px)" }}
        animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
        exit={{ opacity: 0, scale: 0.97, filter: "blur(4px)", transition: { duration: 0.15 } }}
        transition={{ type: "spring", bounce: 0, duration: 0.35 }}
        className="glass-thick flex w-full max-w-[400px] flex-col gap-5 rounded-[32px] p-7"
      >
        <div className="flex flex-col gap-2">
          <h2 id="confirm-title" className="text-xl font-semibold tracking-[-0.02em] text-fog-50">
            {title}
          </h2>
          <div id="confirm-body" className="text-[15px] leading-relaxed text-fog-300">
            {body}
          </div>
          {error && (
            <p role="alert" className="text-[14px] text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex gap-2 max-sm:flex-col-reverse sm:justify-end">
          <Button ref={cancel} variant="ghost" onClick={onCancel} disabled={busy} className="max-sm:h-12">
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            loading={busy}
            className="bg-danger text-ink-950 shadow-none hover:bg-danger/90 active:bg-danger/80 max-sm:h-12"
          >
            {action}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
