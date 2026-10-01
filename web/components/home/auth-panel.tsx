import { useState } from "react";
import { motion } from "motion/react";
import { CouchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api, ApiError, type Invite, type User } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Avatar } from "@/components/ui/avatar";

type Mode = "login" | "signup";

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function AuthPanel({
  onAuthed,
  inviteCode,
  invite,
}: {
  onAuthed: (u: User) => void;
  inviteCode?: string; // came from an invite link: they join that room once in
  // Its preview: undefined while loading, "missing" for a code with no room, null if it
  // didn't load.
  invite?: Invite | "missing" | null;
}) {
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
    <div className="flex flex-col gap-[18px] sm:gap-6">
      {inviteCode ? (
        <div className="enter flex flex-col gap-[18px] sm:gap-6">
          <InviteCard code={inviteCode} invite={invite} />
          <h1 className="text-[36px] leading-[1.05] font-semibold tracking-[-0.035em] text-fog-50 sm:text-[48px]">Pull up a seat.</h1>
        </div>
      ) : (
        <div className="enter flex flex-col gap-3">
          <h1 className="text-[36px] leading-[1.05] font-semibold tracking-[-0.035em] text-fog-50 sm:text-[52px] sm:leading-[1.02]">
            {signup ? (
              "Pull up a seat."
            ) : (
              <>
                Your seat&rsquo;s <br className="max-sm:hidden" />
                waiting.
              </>
            )}
          </h1>
          <p className="text-[18px] leading-normal text-fog-300 max-sm:hidden">Watch films together, at the same moment, from anywhere.</p>
        </div>
      )}

      <form onSubmit={submit} noValidate className="flex flex-col gap-[18px] sm:gap-6">
        <div role="tablist" aria-label="Account" className="relative grid grid-cols-2 gap-1 rounded-full bg-ink-800 p-1">
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
              className={`relative h-11 rounded-full text-[15px] font-semibold transition-colors duration-200 ${
                mode === m ? "text-fog-50" : "text-fog-500 hover:text-fog-300"
              }`}
            >
              {mode === m && (
                <motion.span
                  layoutId="auth-tab"
                  className="absolute inset-0 rounded-full bg-ink-700"
                  transition={{ type: "spring", bounce: 0, duration: 0.35 }}
                />
              )}
              <span className="relative">{m === "login" ? "Log in" : "Sign up"}</span>
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
          placeholder={signup ? "What friends will see" : undefined}
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
          placeholder={signup ? "At least 8 characters" : undefined}
          error={passwordError}
        />

        {error && (
          <p role="alert" className="enter flex items-start gap-2 rounded-[22px] bg-danger/10 px-4 py-3 text-[14px] leading-snug text-danger">
            <WarningCircleIcon size={18} weight="fill" className="mt-px shrink-0" />
            {error}
          </p>
        )}

        <Button type="submit" size="xl" loading={busy} disabled={!username || !password} className="mt-1 h-[60px] w-full text-[17px]">
          {signup ? (inviteCode ? "Create account and join" : "Create account") : inviteCode ? "Log in and join" : "Log in"}
        </Button>
      </form>
    </div>
  );
}

// Who sent you here: their initial, "Rafe invited you to a room", and the code.
function InviteCard({ code, invite }: { code: string; invite?: Invite | "missing" | null }) {
  const owner = invite && invite !== "missing" ? invite.owner : undefined;
  const missing = invite === "missing";
  return (
    <div className="flex items-center gap-3.5 rounded-[28px] bg-ink-800 px-[18px] py-3.5">
      {owner ? (
        <Avatar name={owner} size={44} />
      ) : (
        <span
          className={`grid size-11 shrink-0 place-items-center rounded-full bg-ink-600 text-fog-300 ${invite === undefined ? "skeleton" : ""}`}
          aria-hidden
        >
          {invite !== undefined && <CouchIcon size={20} />}
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className={`truncate text-[15px] ${missing ? "text-fog-300" : "text-fog-100"}`}>
          {owner
            ? `${owner} invited you to a room`
            : missing
              ? "There\u2019s no room with this code"
              : invite === undefined
                ? "\u00a0"
                : "You\u2019re invited to a room"}
        </p>
        <p className={`font-mono text-[14px] tracking-[0.14em] ${missing ? "text-fog-500 line-through" : "text-plum-200"}`}>{code}</p>
      </div>
    </div>
  );
}
