import { forwardRef } from "react";
import { Spinner } from "./spinner";

type Variant = "primary" | "secondary" | "danger" | "glass" | "ghost";
type Size = "md" | "lg" | "xl" | "icon" | "icon-lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-plum-700 text-fog-50 shadow-[inset_0_1px_0_rgb(255_255_255/0.14)] hover:bg-[#7d3070] active:bg-plum-800 [&:disabled:not([aria-busy])]:opacity-40",
  secondary: "bg-ink-700 text-fog-50 hover:bg-ink-600 [&:disabled:not([aria-busy])]:opacity-40",
  danger: "bg-ink-700 text-danger hover:bg-ink-600 [&:disabled:not([aria-busy])]:opacity-40",
  glass: "glass text-fog-100 hover:bg-ink-700/70",
  ghost: "text-fog-300 hover:bg-white/5 hover:text-fog-50 active:bg-white/10",
};

// Pills throughout: the living room has no hard corners.
const sizes: Record<Size, string> = {
  md: "h-11 px-5 text-[15px] rounded-full gap-2",
  lg: "h-14 px-7 text-[17px] rounded-full gap-2.5",
  xl: "h-16 px-8 text-[18px] rounded-full gap-3",
  icon: "size-11 rounded-full",
  "icon-lg": "size-14 rounded-full",
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
