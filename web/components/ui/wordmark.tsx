// The wordmark: lowercase and tight, nothing else.
export function Wordmark({ className = "" }: { className?: string }) {
  return <span className={`text-[20px] font-semibold tracking-[-0.03em] text-fog-50 ${className}`}>anda</span>;
}
