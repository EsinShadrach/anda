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
      className={`relative w-full max-w-[360px] ${invalid && shakeKey ? "animate-shake motion-reduce:animate-none" : ""}`}
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
        className="peer absolute inset-0 z-10 size-full cursor-text opacity-0"
      />
      <div className="grid grid-cols-6 gap-2" aria-hidden>
        {Array.from({ length: LEN }, (_, i) => {
          const char = value[i];
          const active = i === Math.min(value.length, LEN - 1);
          return (
            <div
              key={i}
              data-active={active || undefined}
              className={`grid aspect-[4/5] place-items-center rounded-xl bg-ink-850 font-mono text-2xl font-medium text-fog-50 transition-shadow duration-150 ${
                invalid
                  ? "text-danger shadow-[inset_0_0_0_1.5px_var(--color-danger)]"
                  : "shadow-[inset_0_0_0_1px_var(--color-ink-700)] peer-focus:data-active:shadow-[inset_0_0_0_1.5px_var(--color-ember-500)]"
              }`}
            >
              {char ?? <span className="size-1.5 rounded-full bg-ink-600" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
