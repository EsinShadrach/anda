"use client";

import { MotionConfig } from "motion/react";

// reducedMotion="user": Motion swaps transforms for fades when the OS asks for less motion.
export function Providers({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
