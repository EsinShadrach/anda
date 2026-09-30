import { useState } from "react";
import { motion } from "motion/react";
import { TicketIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api, ApiError, type User } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

type Mode = "login" | "signup";

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function AuthPanel({ onAuthed, inviteCode }: { onAuthed: (u: User) => void; inviteCode?: string }) {
  const [mode, setMode] = useState<Mode>(inviteCode ? "signup" : "login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState({ username: false, password: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const signup = mode === "signup";
  const usernameError =
    signup && touched.username && username && !USERNAME_RE.test(username)
      ? "Use 3 to 20 letters, numbers or underscores."
      : undefined;
  const passwordError =
    signup && touched.password && password && password.length < 8 ? "Use at least 8 characters." : undefined;

  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched({ username: true, password: true });
    if (signup && (!USERNAME_RE.test(username) || password.length < 8)) return;
    setError("");
    setBusy(true);
    try {
      onAuthed(signup ? await api.signup(username, password) : await api.login(username, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Anda. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {inviteCode ? (
        <div className="enter flex flex-col gap-4">
          <span className="inline-flex w-fit items-center gap-2 rounded-full bg-ember-500/12 px-3 py-1.5 text-[13px] font-medium text-ember-300 ring-1 ring-ember-500/25">
            <TicketIcon size={16} weight="fill" />
            Invite to room <span className="font-mono tracking-[0.12em]">{inviteCode}</span>
          </span>
          <h1 className="text-[40px] leading-[1.02] font-semibold tracking-[-0.035em] text-fog-50 sm:text-5xl">
            Your seat&rsquo;s
            <span className="block text-balance text-fog-500">being saved.</span>
          </h1>
          <p className="max-w-[40ch] text-[17px] leading-relaxed text-fog-300">
            Create an account or log in, and you&rsquo;ll go straight into the room.
          </p>
        </div>
      ) : (
        <div className="enter flex flex-col gap-4">
          <h1 className="text-[40px] leading-[1.02] font-semibold tracking-[-0.035em] text-fog-50 sm:text-5xl">
            Movie night,
            <span className="block text-balance text-fog-500">wherever everyone is.</span>
          </h1>
          <p className="max-w-[40ch] text-[17px] leading-relaxed text-fog-300">
            Start a room, share the code, and watch the same moment together. The chat rides along.
          </p>
        </div>
      )}

      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div role="tablist" aria-label="Account" className="relative grid grid-cols-2 rounded-2xl bg-ink-850 p-1 ring-1 ring-ink-700">
          {(["login", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => {
                setMode(m);
                setError("");
              }}
              className={`relative h-10 rounded-xl text-[15px] font-semibold transition-colors duration-200 ${mode === m ? "text-fog-50" : "text-fog-500 hover:text-fog-300"
                }`}
            >
              {mode === m && (
                <motion.span
                  layoutId="auth-tab"
                  className="absolute inset-0 rounded-xl bg-ink-700 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
                  transition={{ type: "spring", bounce: 0, duration: 0.35 }}
                />
              )}
              <span className="relative">{m === "login" ? "Log in" : "Create account"}</span>
            </button>
          ))}
        </div>

        <Field
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, username: true }))}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={20}
          placeholder={signup ? "e.g. rafe" : undefined}
          hint={signup ? "Letters, numbers and underscores. This is what friends see." : undefined}
          error={usernameError}
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))}
          autoComplete={signup ? "new-password" : "current-password"}
          enterKeyHint="go"
          hint={signup ? "At least 8 characters." : undefined}
          error={passwordError}
        />

        {error && (
          <p role="alert" className="enter flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-3 text-[14px] leading-snug text-danger ring-1 ring-danger/20">
            <WarningCircleIcon size={18} weight="fill" className="mt-px shrink-0" />
            {error}
          </p>
        )}

        <Button type="submit" size="lg" loading={busy} disabled={!username || !password} className="mt-1 w-full">
          {signup ? (inviteCode ? "Create account and join" : "Create my account") : inviteCode ? "Log in and join" : "Log in"}
        </Button>
      </form>
    </div>
  );
}
