export type User = { id: number; username: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "unknown", err?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: User }>("GET", "/api/me").then((r) => r.user),
  signup: (username: string, password: string) =>
    request<{ user: User }>("POST", "/api/auth/signup", { username, password }).then((r) => r.user),
  login: (username: string, password: string) =>
    request<{ user: User }>("POST", "/api/auth/login", { username, password }).then((r) => r.user),
  logout: () => request<void>("POST", "/api/auth/logout"),
};

export type RoomInfo = { code: string; owner?: string; online: number };

/** A room on your profile. `mine` means you started it, so you can end it. */
export type VisitedRoom = {
  code: string;
  owner: string;
  mine: boolean;
  online: number;
  here?: string[]; // who's in it now (a few names, in join order)
  film?: string; // on screen now, or the one it left off on
  poster?: string;
  created_at: number; // unix ms
  last_joined_at: number; // unix ms
};

/** What an invite link shows before signing in: whose room, and who's in it now. */
export type Invite = { code: string; owner?: string; online: number; here?: string[] };

export const rooms = {
  invite: (code: string) => request<Invite>("GET", `/api/invites/${encodeURIComponent(code)}`),
  create: () => request<{ room: RoomInfo }>("POST", "/api/rooms").then((r) => r.room),
  get: (code: string) =>
    request<{ room: RoomInfo }>("GET", `/api/rooms/${encodeURIComponent(code)}`).then((r) => r.room),
  visited: () => request<{ rooms: VisitedRoom[] }>("GET", "/api/me/rooms").then((r) => r.rooms),
  /** Deletes the room for everyone. Owner only. */
  end: (code: string) => request<void>("DELETE", `/api/rooms/${encodeURIComponent(code)}`),
  /** Takes the room off your list; it keeps existing. */
  forget: (code: string) => request<void>("DELETE", `/api/me/rooms/${encodeURIComponent(code)}`),
};

const CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";

/** Uppercases a typed code and drops anything that can't be in one. */
export function cleanCode(input: string): string {
  return input
    .toUpperCase()
    .split("")
    .filter((c) => CODE_ALPHABET.includes(c))
    .join("")
    .slice(0, 6);
}

export type Film = {
  id: number;
  title: string;
  url: string;
  size_bytes: number;
  duration?: number;
  poster?: string;
  year?: string;
  state?: "ready" | "preparing";
  last_watched_at?: number;
};

/** A search result from the catalog (Cinemeta) or the built-in open films. */
export type CatalogFilm = { id: string; name: string; year?: string; poster?: string; free?: boolean };

export type FilmDetails = {
  id: string;
  name: string;
  year?: string;
  poster?: string;
  background?: string;
  description?: string;
  runtime?: string;
  genres?: string[];
};

export type LibraryStream = {
  key: string;
  release: string;
  source: string;
  quality?: string;
  size_bytes?: number;
  seeders?: number;
  direct?: boolean; // a direct link rather than a torrent
  kbps?: number; // estimated bitrate (size / runtime)
};

export type Progress = {
  state: "preparing" | "ready" | "incompatible" | "failed";
  error?: string;
  prepared_seconds: number;
  duration: number;
  downloaded: number;
  size_bytes: number;
  speed: number;
  peers: number;
  direct?: boolean; // a direct link: no peers, and downloaded/speed aren't known
};

export const library = {
  ready: () => request<{ films: Film[] }>("GET", "/api/library/ready").then((r) => r.films),
  search: (q: string, signal?: AbortSignal) =>
    requestWith<{ films: CatalogFilm[] }>(`/api/library/search?q=${encodeURIComponent(q)}`, signal).then((r) => r.films),
  streams: (id: string, signal?: AbortSignal) =>
    requestWith<{ meta: FilmDetails; streams: LibraryStream[]; hidden: Record<string, number>; failed?: string[] }>(
      `/api/library/${encodeURIComponent(id)}/streams`,
      signal,
    ),
  prepare: (id: string, key: string) =>
    request<{ film: { id: number; title: string; state: string } }>(
      "POST",
      `/api/library/${encodeURIComponent(id)}/streams/${encodeURIComponent(key)}/prepare`,
    ).then((r) => r.film),
  progress: (mediaId: number) => request<Progress>("GET", `/api/media/${mediaId}/progress`),
};

// GET with an abort signal, for type-ahead search.
async function requestWith<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", signal });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "unknown", err?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}
