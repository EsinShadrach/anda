"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type User } from "@/lib/api";

type Mode = "login" | "signup";

export default function Home() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  return (
    <main className="shell">
      <h1 className="brand">Anda</h1>
      <p className="tagline">Watch movies together.</p>
      {user === undefined ? (
        <div className="card muted">Loading…</div>
      ) : user ? (
        <SignedIn user={user} onLogout={() => setUser(null)} />
      ) : (
        <AuthForm onAuthed={setUser} />
      )}
    </main>
  );
}

function SignedIn({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card">
      <p>
        Signed in as <strong>{user.username}</strong>.
      </p>
      <p className="muted">Rooms are coming next.</p>
      <button
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.logout();
            onLogout();
          } finally {
            setBusy(false);
          }
        }}
      >
        Log out
      </button>
    </div>
  );
}

function AuthForm({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const u = mode === "login" ? await api.login(username, password) : await api.signup(username, password);
      onAuthed(u);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="tabs" role="tablist">
        {(["login", "signup"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? "tab active" : "tab"}
            onClick={() => {
              setMode(m);
              setError("");
            }}
          >
            {m === "login" ? "Log in" : "Sign up"}
          </button>
        ))}
      </div>
      <label>
        Username
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          minLength={3}
          maxLength={20}
          pattern="[A-Za-z0-9_]+"
          title="Letters, numbers and underscores"
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={mode === "signup" ? 8 : undefined}
        />
      </label>
      {mode === "signup" && <p className="hint">3–20 letters, numbers or underscores. Password at least 8 characters.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
      </button>
    </form>
  );
}
