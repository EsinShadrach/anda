import { memo } from "react";
import s from "./projector.module.css";

type Variant = "hero" | "stage" | "off";

/**
 * The screening room: a screen with light playing on it, the projector beam, and a row
 * of seats. "stage" fills the room's player area while nothing is playing; "off" is the
 * lights-out state for a missing room. Memoised: its perpetual motion is pure CSS and
 * should never re-render with the page.
 */
export const Projector = memo(function Projector({
  variant = "hero",
  className = "",
  children,
}: {
  variant?: Variant;
  className?: string;
  children?: React.ReactNode;
}) {
  const mod = variant === "stage" ? s.stage : variant === "off" ? s.off : "";
  return (
    <div className={`${s.root} ${mod} ${className}`}>
      <div className={s.screen} aria-hidden>
        <div className={s.light} />
        <div className={s.light2} />
      </div>
      {variant !== "stage" && (
        <>
          <div className={s.floor} aria-hidden />
          <div className={s.beam} aria-hidden />
          <div className={s.dust} aria-hidden>
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <Seats />
        </>
      )}
      <div className={s.grain} aria-hidden />
      {children}
    </div>
  );
});

// Two rows of seats, a few friends already in them: head and shoulders above the seat backs.
function Seats() {
  const back = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => 20 + i * 88);
  const front = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => -30 + i * 110);
  return (
    <svg className={s.seats} viewBox="0 0 800 170" preserveAspectRatio="xMidYMax slice" aria-hidden>
      <defs>
        <linearGradient id="seat-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgb(232 131 74 / 0.4)" />
          <stop offset="0.1" stopColor="rgb(232 131 74 / 0)" />
        </linearGradient>
      </defs>
      {/* back row: nearer the screen, so a little more light reaches it */}
      <g fill="#17130f">
        <Person x={20 + 3 * 88 + 36} y={70} s={0.8} />
        <Person x={20 + 4 * 88 + 36} y={72} s={0.76} />
        <Person x={20 + 7 * 88 + 36} y={70} s={0.8} />
        {back.map((x) => (
          <path key={x} d={`M${x} 170 V92 q0 -14 14 -14 h44 q14 0 14 14 V170 Z`} />
        ))}
      </g>
      {/* front row: closest to us, darkest, rim-lit from the screen */}
      <g fill="currentColor">
        <Person x={-30 + 1 * 110 + 45} y={100} s={1} />
        <Person x={-30 + 4 * 110 + 45} y={98} s={1.04} />
        {front.map((x) => (
          <path key={x} d={`M${x} 170 V126 q0 -18 18 -18 h54 q18 0 18 18 V170 Z`} />
        ))}
      </g>
      <g fill="url(#seat-rim)">
        {front.map((x) => (
          <path key={x} d={`M${x} 170 V126 q0 -18 18 -18 h54 q18 0 18 18 V170 Z`} />
        ))}
      </g>
    </svg>
  );
}

function Person({ x, y, s: k }: { x: number; y: number; s: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${k})`}>
      <circle cx={0} cy={-18} r={15} />
      <path d="M-30 24 Q-30 2 -12 0 H12 Q30 2 30 24 Z" />
    </g>
  );
}
