import { memo, useLayoutEffect, useRef, useState } from "react";
import { HeartIcon } from "@phosphor-icons/react";

// The scene is drawn in its own 720 × 760 space and scaled into whatever holds it.
const W = 720;
const H = 760;
// Banners (a phone's sign-in, a wide strip) show the scene from y=48 down to the couch.
const BANNER_TOP = 48;
const BANNER_H = 572;

type Fit = "panel" | "banner";

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/** One CSS animation, held at its first frame until it starts and its last once done. */
function anim(name: string, duration: string, easing: string, delay: string, repeat = "1 normal") {
  return { animation: `${duration} ${easing} ${delay} ${repeat} both running ${name}` };
}

// Four friends, left to right: where they sit, when they sit down, and how their heads sit.
const PEOPLE = [
  { left: 160, top: 470, delay: "1.4s", head: { left: 36, w: 48, h: 56, tilt: 0 } },
  { left: 258, top: 462, delay: "1.65s", head: { left: 32, w: 48, h: 56, tilt: -9 } },
  { left: 358, top: 476, delay: "1.9s", head: { left: 36, w: 44, h: 52, tilt: 0 }, bun: true },
  { left: 456, top: 466, delay: "2.15s", head: { left: 36, w: 52, h: 58, tilt: 0 } },
];

/**
 * A living room at night: a floor lamp clicks on, four friends sit down on the couch, the TV
 * comes up plum, and every few seconds a heart drifts off the couch. "off" is the same room
 * with nobody home (a room that's gone). Pure CSS motion on transform and opacity, so it
 * costs nothing once it settles; memoised so the page never re-renders it. Tap to replay.
 * No position of its own: callers place it (relative, absolute or fixed).
 */
export const LivingRoom = memo(function LivingRoom({
  variant = "on",
  fit,
  className = "",
  children,
}: {
  variant?: "on" | "off";
  fit?: Fit; // default: a banner when the box is much wider than tall, else a panel
  className?: string;
  children?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ s: number; x: number; y: number } | null>(null);
  const [take, setTake] = useState(0);

  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const mode = fit ?? (w / h > 1.15 ? "banner" : "panel");
      if (mode === "banner") {
        const s = h / BANNER_H;
        setPlace({ s, x: (w - W * s) / 2, y: -BANNER_TOP * s });
      } else {
        // The couch sits on the bottom edge; spare height above is just more wall.
        const s = Math.min(w / W, h / H);
        setPlace({ s, x: (w - W * s) / 2, y: h - H * s });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const on = variant === "on";
  return (
    <div ref={box} className={`overflow-hidden bg-ink-950 ${className}`}>
      <div
        key={take}
        aria-hidden
        onClick={on ? () => setTake((t) => t + 1) : undefined}
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: W,
          height: H,
          transform: place ? `translate(${place.x}px, ${place.y}px) scale(${place.s})` : undefined,
          visibility: place ? "visible" : "hidden",
        }}
      >
        {/* Floor, wide enough to run past the scene's edges on any screen. */}
        <div className="absolute top-[590px] -right-[2000px] -left-[2000px] h-[400px] bg-[linear-gradient(#16130f,#0b0a09)]" />

        {on && (
          <>
            <div
              data-anim
              className="absolute top-[-34px] left-[-40px] h-[560px] w-[800px] bg-[radial-gradient(rgb(156_74_140/0.34),transparent_62%)]"
              style={anim("anda-glow", "1.6s", "linear", "2.9s")}
            />
            <div
              data-anim
              className="absolute top-[572px] left-[110px] h-[140px] w-[500px] bg-[radial-gradient(at_50%_30%,rgb(156_74_140/0.24),transparent_70%)]"
              style={anim("anda-glow", "1.6s", "linear", "2.9s")}
            />
          </>
        )}

        {/* The lamp: pole, base, shade; and when on, its light. */}
        <div className="absolute top-[232px] left-[88px] h-[360px] w-[5px] rounded-[3px] bg-ink-800" />
        <div className="absolute top-[586px] left-[62px] h-[10px] w-[56px] rounded-[5px] bg-ink-800" />
        <div className="absolute top-[180px] left-[56px] h-[56px] w-[70px] bg-ink-700 [clip-path:polygon(20%_0,80%_0,100%_100%,0_100%)]" />
        {on && (
          <div data-anim className="absolute inset-0" style={anim("anda-flicker", "1.4s", "linear", "0.3s")}>
            <div className="absolute top-[70px] left-[-20px] size-[220px] bg-[radial-gradient(circle,rgb(231_185_220/0.32),transparent_65%)]" />
            <div className="absolute top-[236px] left-[-4px] h-[360px] w-[190px] bg-[linear-gradient(rgb(231_185_220/0.2),rgb(231_185_220/0))] [clip-path:polygon(38%_0,62%_0,100%_100%,0_100%)]" />
            <div className="absolute top-[560px] left-[-50px] h-[80px] w-[280px] bg-[radial-gradient(rgb(231_185_220/0.26),transparent_70%)]" />
            <div className="absolute top-[180px] left-[56px] h-[56px] w-[70px] bg-[linear-gradient(#fbe8f3,#c27ab4)] [clip-path:polygon(20%_0,80%_0,100%_100%,0_100%)]" />
          </div>
        )}

        {/* The TV and its stand. */}
        <div className="absolute top-[150px] left-[190px] h-[192px] w-[340px] rounded-[14px] bg-ink-850">
          <div className="absolute inset-2 overflow-hidden rounded-[8px] bg-[#0e0d0c]">
            {on && (
              <>
                <div
                  data-anim
                  className="absolute inset-0 bg-[radial-gradient(at_30%_60%,#9c4a8c_0%,#5a2a50_40%,#2e1729_85%)]"
                  style={anim("anda-glow", "1.6s", "linear", "2.9s")}
                />
                <div
                  data-anim
                  className="absolute inset-0 bg-[radial-gradient(at_75%_35%,#c27ab4_0%,#5a2a50_45%,#2e1729_90%)] opacity-0"
                  style={anim("anda-shimmer", "5s", "ease-in-out", "4.6s", "infinite alternate")}
                />
              </>
            )}
          </div>
        </div>
        <div className="absolute top-[356px] left-[230px] h-5 w-[260px] rounded-[6px] bg-[#141210]" />

        {on &&
          PEOPLE.map((p, i) => (
            <div key={i} data-anim className="absolute h-[260px] w-[120px]" style={{ left: p.left, top: p.top, ...anim("anda-rise", "1s", EASE_OUT, p.delay) }}>
              <div
                className="absolute top-0 origin-bottom rounded-full bg-[#050404] shadow-[0_-2px_0_rgb(231_185_220/0.22)]"
                style={{ left: p.head.left, width: p.head.w, height: p.head.h, transform: `rotate(${p.head.tilt}deg)` }}
              />
              {p.bun && <div className="absolute top-[-14px] left-[50px] size-[22px] rounded-full bg-[#050404] shadow-[0_-2px_0_rgb(231_185_220/0.22)]" />}
              <div className="absolute top-[46px] left-0 h-[214px] w-[120px] rounded-[60px_60px_24px_24px] bg-[#050404] shadow-[0_-2px_0_rgb(231_185_220/0.16)]" />
            </div>
          ))}

        {on && (
          <>
            <span data-anim className="absolute top-[430px] left-[300px] text-plum-200 opacity-0" style={anim("anda-float", "7s", "ease-out", "5.2s", "infinite normal")}>
              <HeartIcon size={30} weight="fill" />
            </span>
            <span data-anim className="absolute top-[430px] left-[430px] text-plum-200 opacity-0" style={anim("anda-float", "7s", "ease-out", "7.6s", "infinite normal")}>
              <HeartIcon size={24} weight="fill" />
            </span>
          </>
        )}

        {/* The couch: arms, then the back, its top edge catching the TV's light. */}
        <div className="absolute top-[596px] left-[84px] h-[220px] w-[70px] rounded-[35px] bg-[#1a1816]" />
        <div className="absolute top-[596px] left-[566px] h-[220px] w-[70px] rounded-[35px] bg-[#1a1816]" />
        <div className="absolute top-[560px] left-[110px] h-[260px] w-[500px] rounded-[56px] bg-ink-800 shadow-[inset_0_2px_0_rgb(231_185_220/0.1)]">
          {on && (
            <div
              data-anim
              className="absolute inset-0 rounded-[56px] shadow-[inset_0_3px_0_rgb(194_122_180/0.35)]"
              style={anim("anda-glow", "1.6s", "linear", "2.9s")}
            />
          )}
        </div>
      </div>
      {children}
    </div>
  );
});
