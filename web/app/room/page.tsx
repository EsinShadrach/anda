"use client";

import { Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, cleanCode } from "@/lib/api";
import { RoomConnection, type ChatItem, type Member, type RoomView } from "@/lib/room";
import "./room.css";

export default function RoomPage() {
  return (
    <Suspense>
      <RoomGate />
    </Suspense>
  );
}

// Signed-out visitors (e.g. from an invite link) log in first, then come back here.
function RoomGate() {
  const router = useRouter();
  const code = cleanCode(useSearchParams().get("code") ?? "");
  const [ok, setOk] = useState(false);

  useEffect(() => {
    api.me().then(
      () => setOk(true),
      () => router.replace(`/?next=${encodeURIComponent(`/room?code=${code}`)}`),
    );
  }, [router, code]);

  if (code.length !== 6) return <Gone />;
  return ok ? <Room code={code} /> : null;
}

function Room({ code }: { code: string }) {
  const router = useRouter();
  const [conn] = useState(() => new RoomConnection(code));
  const view = useSyncExternalStore(conn.subscribe, conn.getSnapshot, conn.getSnapshot);

  useEffect(() => {
    conn.start();
    return () => conn.stop();
  }, [conn]);

  if (view.notFound) return <Gone />;

  return (
    <div className="room">
      <header className="room-header">
        <button className="btn btn-quiet icon-btn" onClick={() => router.push("/")} aria-label="Leave room">
          <ArrowLeft />
        </button>
        <InviteButton code={code} />
        <div className="header-end">
          <AvatarStack members={view.members} />
        </div>
        <div className="reconnect" data-visible={view.status === "reconnecting"} role="status">
          Reconnecting…
        </div>
      </header>

      <section className="stage" aria-label="Player">
        <div className="stage-empty">
          <p className="stage-title">Nothing's playing yet</p>
          <p className="stage-sub">Picking a film comes next. Say hi in the meantime.</p>
        </div>
      </section>

      <aside className="side">
        <MemberList view={view} />
        <Chat view={view} conn={conn} />
      </aside>

      {view.status === "replaced" && (
        <Dialog
          title="Anda is open somewhere else"
          body="This room is open in another tab or device."
          action="Use here instead"
          onAction={() => conn.takeOver()}
        />
      )}
      {view.status === "outdated" && (
        <Dialog
          title="Anda was updated"
          body="Refresh to get the latest version."
          action="Refresh"
          onAction={() => location.reload()}
        />
      )}
    </div>
  );
}

function InviteButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const url = `${location.origin}/room?code=${code}`;
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: "Join my Anda room", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Share sheet dismissed or clipboard blocked: nothing to do.
    }
  }

  return (
    <button className="invite" onClick={copy} data-copied={copied} aria-label={`Room ${code}. Copy invite link`}>
      <span className="invite-code">{code}</span>
      <span className="invite-label" aria-hidden>
        <span className="invite-idle">Invite</span>
        <span className="invite-done">Copied</span>
      </span>
    </button>
  );
}

function MemberList({ view }: { view: RoomView }) {
  return (
    <section className="members" aria-label="People in this room">
      <h2 className="side-heading">
        In the room <span className="count">{view.members.length}</span>
      </h2>
      <ul className="member-list">
        {view.members.map((m) => (
          <li key={m.user_id} className="member enter">
            <Avatar member={m} />
            <span className="member-name">
              {m.username}
              {m.user_id === view.me && <span className="you"> (you)</span>}
            </span>
            {m.user_id === view.host && <span className="badge">Host</span>}
            {m.status === "away" && <span className="away-label">away</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AvatarStack({ members }: { members: Member[] }) {
  const shown = members.slice(0, 4);
  return (
    <div className="avatar-stack" aria-label={`${members.length} in the room`}>
      {shown.map((m) => (
        <Avatar key={m.user_id} member={m} small />
      ))}
      {members.length > shown.length && <span className="avatar avatar-more">+{members.length - shown.length}</span>}
    </div>
  );
}

function Avatar({ member, small }: { member: Member; small?: boolean }) {
  return (
    <span
      className={small ? "avatar avatar-sm" : "avatar"}
      style={{ "--hue": hue(member.username) } as React.CSSProperties}
      data-status={member.status}
      title={`${member.username} (${member.status})`}
    >
      {member.username.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Chat({ view, conn }: { view: RoomView; conn: RoomConnection }) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const nearBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const canSend = view.status === "open" && view.joined;

  // Follow new messages only if the reader is already at the bottom.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (nearBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setUnseen(true);
    }
  }, [view.chat.length]);

  function onScroll() {
    const el = listRef.current!;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom.current) setUnseen(false);
  }

  function jumpDown() {
    const el = listRef.current!;
    nearBottom.current = true;
    setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (conn.sendChat(draft)) {
      setDraft("");
      nearBottom.current = true;
    }
  }

  return (
    <section className="chat" aria-label="Chat">
      <ol className="chat-list" ref={listRef} onScroll={onScroll} aria-live="polite">
        {view.chat.length === 0 && view.joined && <li className="chat-empty">No messages yet.</li>}
        {view.chat.map((item, i) => (
          <ChatRow key={item.key} item={item} prev={view.chat[i - 1]} me={view.me} />
        ))}
      </ol>
      {unseen && (
        <button className="new-pill" onClick={jumpDown}>
          New messages
        </button>
      )}
      <div className="notice" data-visible={!!view.notice} role="status">
        {view.notice}
      </div>
      <form className="composer" onSubmit={submit}>
        <input
          className="input composer-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={canSend ? "Say something" : "Connecting…"}
          aria-label="Message"
          maxLength={1000}
          autoComplete="off"
          enterKeyHint="send"
          disabled={!canSend}
        />
        <button className="btn send-btn" disabled={!canSend || !draft.trim()} aria-label="Send">
          <Send />
        </button>
      </form>
    </section>
  );
}

const GROUP_MS = 3 * 60 * 1000;

function ChatRow({ item, prev, me }: { item: ChatItem; prev?: ChatItem; me: number | null }) {
  const cls = item.live ? " enter" : "";
  if (item.kind === "system") {
    return <li className={`chat-system${cls}`}>{item.text}</li>;
  }
  const grouped =
    prev?.kind === "msg" && prev.senderId === item.senderId && item.time - prev.time < GROUP_MS;
  return (
    <li className={`chat-msg${grouped ? " grouped" : ""}${item.pending ? " pending" : ""}${cls}`}>
      {!grouped && (
        <div className="chat-meta">
          <span className={item.senderId === me ? "chat-name mine" : "chat-name"}>{item.sender}</span>
          <time className="chat-time" dateTime={new Date(item.time).toISOString()}>
            {formatTime(item.time)}
          </time>
        </div>
      )}
      <p className="chat-text">{item.text}</p>
    </li>
  );
}

function Dialog({ title, body, action, onAction }: { title: string; body: string; action: string; onAction: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="overlay">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title" className="card-title">
          {title}
        </h2>
        <p className="hint">{body}</p>
        <button ref={ref} className="btn" onClick={onAction}>
          {action}
        </button>
      </div>
    </div>
  );
}

function Gone() {
  const router = useRouter();
  return (
    <main className="home">
      <div className="card enter">
        <h2 className="card-title">No room with that code</h2>
        <p className="hint">Check the code, or start a new room.</p>
        <button className="btn" onClick={() => router.push("/")}>
          Back home
        </button>
      </div>
    </main>
  );
}

function hue(name: string): number {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function formatTime(ms: number) {
  return timeFmt.format(ms);
}

function ArrowLeft() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M12.5 4.5 7 10l5.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Send() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M10 16V4m0 0-5 5m5-5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
