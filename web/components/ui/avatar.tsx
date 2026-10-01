type Props = {
  name: string;
  status?: "online" | "away";
  size?: number;
  ring?: boolean; // separates overlapping avatars in a stack
  self?: boolean; // your own initial is in the accent
};

export function hue(name: string): number {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// A soft, barely tinted disc with the initial: everyone keeps the same shade everywhere,
// quiet enough to sit beside the film.
export function Avatar({ name, status, size = 32, ring, self }: Props) {
  const h = hue(name);
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center rounded-full font-semibold ${self ? "text-plum-200" : "text-fog-50"} ${ring ? "ring-2 ring-ink-850" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        background: `oklch(0.39 0.025 ${h})`,
      }}
      title={status ? `${name} · ${status}` : name}
    >
      {name.slice(0, 1).toUpperCase()}
      {status && (
        <span
          className={`absolute -right-px -bottom-px rounded-full ring-2 ring-ink-850 transition-colors duration-300 ${
            status === "online" ? "bg-live" : "bg-away"
          }`}
          style={{ width: Math.max(8, size * 0.28), height: Math.max(8, size * 0.28) }}
        />
      )}
    </span>
  );
}
