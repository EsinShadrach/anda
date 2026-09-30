// The wordmark: lowercase, tight, with the ember "projector lamp" dot.
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-[3px] text-[22px] font-semibold tracking-[-0.04em] text-fog-50 ${className}`}>
      anda
      <span className="size-[7px] rounded-full bg-ember-500 shadow-[0_0_12px_2px_rgb(232_131_74/0.6)]" aria-hidden />
    </span>
  );
}
