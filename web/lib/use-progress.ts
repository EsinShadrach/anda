import { useEffect, useState } from "react";
import { library, type Progress } from "./api";

// Polls a Library film's download/preparation progress every 2s until it's done (or
// failed). Cheap on the server: one small stats request per viewer while preparing.
export function useProgress(mediaId: number, preparing: boolean): Progress | null {
  const [p, setP] = useState<Progress | null>(null);

  useEffect(() => {
    setP(null);
    if (!preparing) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await library.progress(mediaId);
        if (!live) return;
        setP(next);
        if (next.state !== "preparing") return; // done or failed: stop polling
      } catch {
        // transient; try again next tick
      }
      if (live) timer = setTimeout(tick, 2000);
    };
    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mediaId, preparing]);

  return p;
}
