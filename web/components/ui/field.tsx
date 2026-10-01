import { useId, useState } from "react";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: string;
  error?: string;
};

// Label above, message below: a hint until something is wrong, then the error.
export function Field({ label, hint, error, type, className = "", ...rest }: Props) {
  const id = useId();
  const [reveal, setReveal] = useState(false);
  const isPassword = type === "password";
  const message = error || hint;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <label htmlFor={id} className="text-[14px] font-medium text-fog-300">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={isPassword && reveal ? "text" : type}
          aria-invalid={!!error || undefined}
          aria-describedby={message ? `${id}-msg` : undefined}
          className={`h-14 w-full rounded-full bg-ink-800 px-5 text-base text-fog-50 transition-shadow duration-150 outline-none placeholder:text-fog-600 focus:shadow-[0_0_0_2px_var(--color-plum-600)] aria-invalid:shadow-[0_0_0_2px_var(--color-danger)] ${isPassword ? "pr-14" : ""}`}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? "Hide password" : "Show password"}
            className="press absolute inset-y-0 right-2 my-auto grid size-10 place-items-center rounded-full text-fog-500 hover:text-fog-100"
          >
            {reveal ? <EyeSlashIcon size={20} /> : <EyeIcon size={20} />}
          </button>
        )}
      </div>
      {message && (
        <p id={`${id}-msg`} className={`text-[13px] leading-snug ${error ? "text-danger" : "text-fog-500"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
