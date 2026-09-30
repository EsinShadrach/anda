import { forwardRef } from "react";
import { Spinner } from "./spinner";

type Variant = "primary" | "glass" | "ghost";
type Size = "md" | "lg" | "icon";

const variants: Record<Variant, string> = {
  primary:
    "bg-ember-500 text-ink-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_8px_24px_-8px_rgb(232_131_74/0.6)] hover:bg-ember-400 active:bg-ember-600 [&:disabled:not([aria-busy])]:opacity-40 disabled:shadow-none",
  glass: "glass text-fog-100 hover:bg-ink-700/70",
  ghost: "text-fog-300 hover:bg-white/5 hover:text-fog-50 active:bg-white/10",
};

const sizes: Record<Size, string> = {
  md: "h-11 px-4 text-[15px] rounded-xl gap-2",
  lg: "h-14 px-6 text-base rounded-2xl gap-2.5",
  icon: "size-11 rounded-xl",
};

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "primary", size = "md", loading, disabled, className = "", children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`press inline-flex shrink-0 items-center justify-center font-semibold tracking-[-0.01em] ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner /> : children}
    </button>
  );
});
