import { CircleNotchIcon } from "@phosphor-icons/react";

// Spins fast on purpose: a quick spinner makes the same wait feel shorter.
export function Spinner({ size = 18, className = "" }: { size?: number; className?: string }) {
  return <CircleNotchIcon size={size} weight="bold" className={`animate-spin-fast ${className}`} aria-hidden />;
}
