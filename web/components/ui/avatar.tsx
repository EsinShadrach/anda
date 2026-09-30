type Props = {
  name: string;
  status?: "online" | "away";
  size?: number;
  ring?: boolean; // separates overlapping avatars in a stack
};

export function hue(name: string): number {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// A two-tone orb from the username, so everyone keeps the same colour everywhere.
export function Avatar({ name, status, size = 32, ring }: Props) {
  const h = hue(name);
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center rounded-full font-semibold text-white/95 ${ring ? "ring-2 ring-ink-900" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `radial-gradient(circle at 30% 25%, oklch(0.8 0.1 ${h}), oklch(0.55 0.13 ${(h + 35) % 360}) 70%)`,
        textShadow: "0 1px 2px rgb(0 0 0 / 0.3)",
      }}
      title={status ? `${name} · ${status}` : name}
    >
      {name.slice(0, 1).toUpperCase()}
      {status && (
        <span
          className={`absolute -right-px -bottom-px rounded-full ring-2 ring-ink-900 transition-colors duration-300 ${
            status === "online" ? "bg-live" : "bg-away"
          }`}
          style={{ width: Math.max(8, size * 0.28), height: Math.max(8, size * 0.28) }}
        />
      )}
    </span>
  );
}
