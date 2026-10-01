import { useRef } from "react";
import { cleanCode } from "@/lib/api";

const LEN = 6;

type Props = {
  value: string;
  onChange: (code: string) => void;
  onComplete?: (code: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  shakeKey?: number; // bump to replay the shake
};

// One real input under six painted cells: paste, autofill, backspace and IME all work
// natively, and screen readers see a single field.
export function CodeInput({ value, onChange, onComplete, invalid, disabled, shakeKey }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  return (
    <div
      key={shakeKey}
      className={`group relative w-full max-w-[434px] ${invalid && shakeKey ? "animate-shake motion-reduce:animate-none" : ""}`}
      onClick={() => ref.current?.focus()}
    >
      <input
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = cleanCode(e.target.value);
          onChange(next);
          if (next.length === LEN && value.length !== LEN) onComplete?.(next);
        }}
        aria-label="Room code"
        aria-invalid={invalid || undefined}
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        maxLength={LEN}
        className="absolute inset-0 z-10 size-full cursor-text opacity-0"
      />
      <div className="grid grid-cols-6 gap-2.5 max-sm:gap-2" aria-hidden>
        {Array.from({ length: LEN }, (_, i) => {
          const char = value[i];
          const active = i === Math.min(value.length, LEN - 1);
          return (
            <div
              key={i}
              data-active={active || undefined}
              className={`grid aspect-square place-items-center rounded-[23px] bg-ink-800 font-mono text-[28px] text-fog-50 transition-shadow duration-150 max-sm:rounded-[18px] max-sm:text-2xl ${
                invalid
                  ? "text-danger shadow-[inset_0_0_0_2px_var(--color-danger)]"
                  : "group-focus-within:data-active:shadow-[inset_0_0_0_2px_var(--color-plum-400)]"
              }`}
            >
              {char ??
                (active ? (
                  <span className="hidden h-7 w-0.5 rounded-full bg-plum-400 group-focus-within:block group-focus-within:animate-caret motion-reduce:animate-none" />
                ) : null)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
