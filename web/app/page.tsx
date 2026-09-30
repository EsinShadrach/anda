"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, cleanCode, rooms, type User } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  // Back to the invite link that sent a signed-out visitor here.
  function onAuthed(u: User) {
    const next = new URLSearchParams(location.search).get("next");
    if (next?.startsWith("/room?")) {
      router.replace(next);
      return;
    }
    setUser(u);
  }

  return (
    <main className="home">
      <header className="home-top">
        <div>
          <h1 className="brand">
            Anda<span className="brand-dot">.</span>
          </h1>
          <p className="tagline">Watch movies together.</p>
        </div>
        {user && <SignOut user={user} onDone={() => setUser(null)} />}
      </header>
      {user === undefined ? null : user ? <Lobby /> : <AuthForm onAuthed={onAuthed} />}
    </main>
  );
}

function SignOut({ user, onDone }: { user: User; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="whoami">
      <span>{user.username}</span>
      <button
        className="btn btn-quiet"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.logout();
            onDone();
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

function Lobby() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setError("");
    setCreating(true);
    try {
      const room = await rooms.create();
      router.push(`/room?code=${room.code}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
      setCreating(false);
    }
  }

  async function join(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (code.length !== 6) return;
    setError("");
    setJoining(true);
    try {
      const room = await rooms.get(code);
      router.push(`/room?code=${room.code}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
      setJoining(false);
    }
  }

  return (
    <div className="card enter">
      <h2 className="card-title">Start a watch party</h2>
      <p className="hint">You'll get a code to share with friends.</p>
      <button className="btn" onClick={create} disabled={creating}>
        {creating ? "Creating…" : "Start a room"}
      </button>
      <div className="or">or join one</div>
      <form className="join-row" onSubmit={join}>
        <input
          className="input code-input"
          value={code}
          onChange={(e) => setCode(cleanCode(e.target.value))}
          placeholder="••••••"
          aria-label="Room code"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <button className="btn btn-ghost" disabled={code.length !== 6 || joining}>
          Join
        </button>
      </form>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

type Mode = "login" | "signup";

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
    <form className="card enter" onSubmit={submit}>
      <div className="tabs" role="tablist">
        {(["login", "signup"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className="tab"
            onClick={() => {
              setMode(m);
              setError("");
            }}
          >
            {m === "login" ? "Log in" : "Sign up"}
          </button>
        ))}
      </div>
      <label className="field">
        Username
        <input
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          minLength={3}
          maxLength={20}
          pattern="[A-Za-z0-9_]+"
          title="Letters, numbers and underscores"
        />
      </label>
      <label className="field">
        Password
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={mode === "signup" ? 8 : undefined}
          enterKeyHint="go"
        />
      </label>
      {mode === "signup" && <p className="hint">3–20 letters, numbers or underscores. Password at least 8 characters.</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
      </button>
    </form>
  );
}
