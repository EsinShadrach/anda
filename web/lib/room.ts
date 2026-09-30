// Client side of the room WebSocket: connects, resumes, reconnects, and folds server
// messages into one immutable RoomView that React reads via useSyncExternalStore.
// Message names and fields follow the plan's "WebSocket protocol" section.

export const PROTOCOL_VERSION = 1;

export type Member = { user_id: number; username: string; status: "online" | "away" };

export type ChatItem =
  | {
      kind: "msg";
      key: string;
      senderId: number;
      sender: string;
      text: string;
      time: number;
      pending: boolean;
      live: boolean; // arrived while watching (animates in); history doesn't
    }
  | { kind: "system"; key: string; text: string; time: number; live: boolean };

export type ConnStatus =
  | "connecting" // first connection
  | "open"
  | "reconnecting"
  | "replaced" // another tab took over; don't reconnect on our own
  | "outdated"; // protocol version changed; needs a refresh

export type RoomView = {
  status: ConnStatus;
  joined: boolean;
  notFound: boolean;
  me: number | null;
  code: string;
  host: number;
  members: Member[];
  chat: ChatItem[];
  notice: string | null; // short-lived inline error, e.g. rate limited
};

type Envelope = { type: string; v: number; payload?: any };

const TOKEN_KEY = "anda.resume";

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeToken(token: string) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private mode etc.: we just won't resume, and rejoin instead.
  }
}

function wsURL(): string {
  if (process.env.NODE_ENV === "development") return process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export class RoomConnection {
  private ws: WebSocket | null = null;
  private view: RoomView;
  private listeners = new Set<() => void>();
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay: number | null = null; // from reconnect_later
  private closedByUs = false;
  private nextClientId = 0;

  constructor(code: string) {
    this.view = {
      status: "connecting",
      joined: false,
      notFound: false,
      me: null,
      code,
      host: 0,
      members: [],
      chat: [],
      notice: null,
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.view;

  start() {
    this.closedByUs = false;
    this.open();
  }

  /** Leave the room and stop reconnecting (navigating away inside the app). */
  stop() {
    this.closedByUs = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.noticeTimer);
    if (this.ws?.readyState === WebSocket.OPEN) this.send("leave_room");
    this.ws?.close(1000);
    this.ws = null;
  }

  /** "Use here instead": take the session back from the other tab. */
  takeOver() {
    this.attempt = 0;
    this.set({ status: "connecting" });
    this.open();
  }

  sendChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.view.status !== "open") return false;
    const clientId = `c${Date.now().toString(36)}${(this.nextClientId++).toString(36)}`;
    const me = this.view.members.find((m) => m.user_id === this.view.me);
    this.set({
      chat: [
        ...this.view.chat,
        {
          kind: "msg",
          key: clientId,
          senderId: this.view.me ?? 0,
          sender: me?.username ?? "",
          text: trimmed,
          time: Date.now(),
          pending: true,
          live: true,
        },
      ],
    });
    this.send("chat_send", { text: trimmed, client_msg_id: clientId });
    return true;
  }

  private open() {
    clearTimeout(this.retryTimer);
    const ws = new WebSocket(wsURL());
    this.ws = ws;
    ws.onopen = () => {
      const token = readToken();
      this.send("hello", token ? { resume_token: token } : {});
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let env: Envelope;
      try {
        env = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handle(env);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUs || this.view.status === "replaced" || this.view.status === "outdated") return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    this.set({ status: this.view.joined || this.attempt > 0 ? "reconnecting" : "connecting" });
    // Full jitter: a random wait up to an exponentially growing cap, so a server restart
    // doesn't bring every client back in the same instant.
    const cap = Math.min(10_000, 500 * 2 ** this.attempt);
    const delay = this.reconnectDelay ?? Math.random() * cap;
    this.reconnectDelay = null;
    this.attempt++;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private handle({ type, payload }: Envelope) {
    switch (type) {
      case "welcome": {
        this.attempt = 0;
        writeToken(payload.resume_token);
        this.set({ status: "open", me: payload.user_id });
        // A session resumed into this room gets room_state without asking; otherwise join.
        if (payload.room !== this.view.code) this.send("join_room", { code: this.view.code });
        break;
      }
      case "room_state": {
        if (payload.code !== this.view.code) {
          // Resumed into a different room than this page shows: switch.
          this.send("join_room", { code: this.view.code });
          break;
        }
        const history: ChatItem[] = (payload.chat ?? []).map((m: any) => toItem(m, false));
        // Keep our own unsent messages; they'll be echoed or re-sent by the user.
        const pending = this.view.chat.filter((c) => c.kind === "msg" && c.pending);
        this.set({
          joined: true,
          notFound: false,
          host: payload.host,
          members: payload.members,
          chat: mergeHistory(this.view.chat, history).concat(pending),
        });
        break;
      }
      case "chat_message": {
        const item = toItem(payload, true);
        const i = payload.client_msg_id
          ? this.view.chat.findIndex((c) => c.key === payload.client_msg_id)
          : -1;
        if (i >= 0) {
          // Our own message confirmed: keep its key so React doesn't remount (and re-animate) it.
          const chat = this.view.chat.slice();
          chat[i] = { ...item, key: chat[i].key };
          this.set({ chat });
        } else {
          this.set({ chat: [...this.view.chat, item] });
        }
        break;
      }
      case "member_update": {
        const { user_id, username, status } = payload;
        const known = this.view.members.find((m) => m.user_id === user_id);
        let members = this.view.members;
        let system: string | null = null;
        if (status === "left") {
          members = members.filter((m) => m.user_id !== user_id);
          system = `${username} left`;
        } else if (known) {
          members = members.map((m) => (m.user_id === user_id ? { ...m, status } : m));
        } else {
          members = [...members, { user_id, username, status }];
          system = `${username} joined`;
        }
        this.set({ members, chat: system ? [...this.view.chat, sys(system)] : this.view.chat });
        break;
      }
      case "host_changed": {
        const host = this.view.members.find((m) => m.user_id === payload.host);
        this.set({
          host: payload.host,
          chat: host ? [...this.view.chat, sys(`${host.username} is now the host`)] : this.view.chat,
        });
        break;
      }
      case "replaced":
        this.set({ status: "replaced" });
        break;
      case "reconnect_later":
        this.reconnectDelay = (payload.delay ?? 5) * 1000;
        break;
      case "error":
        this.onError(payload.code, payload.message);
        break;
    }
  }

  private onError(code: string, message: string) {
    switch (code) {
      case "protocol_version":
        this.set({ status: "outdated" });
        break;
      case "room_not_found":
        this.set({ notFound: true });
        this.stop();
        break;
      case "rate_limited":
      case "bad_message":
      case "internal":
        // The last pending message didn't go through: drop it and say why.
        this.set({ chat: dropLastPending(this.view.chat) });
        this.flashNotice(message);
        break;
      default:
        this.flashNotice(message);
    }
  }

  private flashNotice(notice: string) {
    clearTimeout(this.noticeTimer);
    this.set({ notice });
    this.noticeTimer = setTimeout(() => this.set({ notice: null }), 3000);
  }

  private send(type: string, payload?: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type, v: PROTOCOL_VERSION, payload }));
  }

  private set(patch: Partial<RoomView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((fn) => fn());
  }
}

let sysSeq = 0;
function sys(text: string): ChatItem {
  return { kind: "system", key: `s${sysSeq++}`, text, time: Date.now(), live: true };
}

function toItem(m: any, live: boolean): ChatItem {
  return {
    kind: "msg",
    key: `m${m.id}`,
    senderId: m.sender.id,
    sender: m.sender.username,
    text: m.text,
    time: m.time,
    pending: false,
    live,
  };
}

// On resume, room_state carries the last 50 messages. Keep items we already show
// (including system lines) and add any we missed while disconnected.
function mergeHistory(current: ChatItem[], history: ChatItem[]): ChatItem[] {
  if (current.length === 0) return history;
  const seen = new Set(current.map((c) => c.key));
  const missed = history.filter((h) => !seen.has(h.key)).map((h) => ({ ...h, live: true }));
  return current.filter((c) => !(c.kind === "msg" && c.pending)).concat(missed);
}

function dropLastPending(chat: ChatItem[]): ChatItem[] {
  for (let i = chat.length - 1; i >= 0; i--) {
    const c = chat[i];
    if (c.kind === "msg" && c.pending) return [...chat.slice(0, i), ...chat.slice(i + 1)];
  }
  return chat;
}
