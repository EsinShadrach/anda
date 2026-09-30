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
