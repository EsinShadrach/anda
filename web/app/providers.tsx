"use client";

import { useEffect } from "react";
import { MotionConfig } from "motion/react";
import { sounds } from "@/lib/sounds";

export function Providers({ children }: { children: React.ReactNode }) {
  // Audio may only start after a gesture. Unlock it on the first one anywhere (the lobby's
  // "Start a room" counts), so a room's first join chime isn't lost.
  useEffect(() => {
    const unlock = () => sounds.unlock();
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    return () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
  }, []);
  // reducedMotion="user": Motion swaps transforms for fades when the OS asks for less motion.
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
