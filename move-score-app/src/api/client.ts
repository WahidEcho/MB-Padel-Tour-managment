/**
 * Talks to the Move Score server. Public reads carry no credentials (so the
 * CDN can share them); personal calls carry the install token and, when signed
 * in, the user's session; referee calls carry the staff token (and the install
 * token, so the server can say which match this phone holds).
 */
import { config } from "../config";
import { session, saveUser } from "../state/session";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

type Who = "public" | "me" | "staff";

export const OFFLINE_MESSAGE = "Can't reach Move Score right now. Check your connection and try again.";

/** A message fit to show a person, whatever was thrown. */
export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : OFFLINE_MESSAGE);

// A match's state is never shared at the CDN. With the install token the server can
// tell this phone whether it holds the scoring lease; it never shows another phone's id.
const MATCH_STATE = /^\/api\/matches\/[^/?]+\/state(\?|$)/;

async function headersFor(who: Who, path: string): Promise<Record<string, string>> {
  const s = session.get();
  const h: Record<string, string> = { Accept: "application/json" };
  if (who === "me") {
    if (s.installToken) h["X-Install-Token"] = s.installToken;
    if (s.user) h.Authorization = `Bearer ${await freshUserToken()}`;
    if (s.staff) h["X-Staff-Token"] = s.staff.token;
  }
  if (who === "staff" && s.staff) h.Authorization = `Bearer ${s.staff.token}`;
  if ((who === "staff" || MATCH_STATE.test(path)) && s.installToken) h["X-Install-Token"] = s.installToken;
  return h;
}

let installRejected: (() => Promise<void>) | null = null;
let lastRecovery = 0;
/** What to do when a personal call is refused for want of a valid install token (push/register.ts registers again). */
export function onInstallRejected(fn: () => Promise<void>) {
  installRejected = fn;
}

let refreshing: Promise<string> | null = null;
/** Refresh tokens are single-use, so concurrent calls share one refresh. */
async function freshUserToken(): Promise<string> {
  const u = session.get().user!;
  if (!u.expiresAt || u.expiresAt * 1000 - Date.now() > 60_000) return u.accessToken;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${config.apiBaseUrl}/api/mobile/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: u.refreshToken }),
        });
        if (!res.ok) {
          await saveUser(null);
          return "";
        }
        const j = (await res.json()) as { accessToken: string; refreshToken: string; expiresAt: number | null };
        await saveUser({ ...u, accessToken: j.accessToken, refreshToken: j.refreshToken, expiresAt: j.expiresAt });
        return j.accessToken;
      } finally {
        setTimeout(() => (refreshing = null), 0);
      }
    })();
  }
  return refreshing;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; who?: Who; timeoutMs?: number; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000);
  opts.signal?.addEventListener("abort", () => ctrl.abort());
  try {
    let res: Response;
    try {
      res = await fetch(`${config.apiBaseUrl}${path}`, {
        method: opts.method ?? (opts.body ? "POST" : "GET"),
        headers: { ...(await headersFor(opts.who ?? "public", path)), ...(opts.headers ?? {}), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      // No response at all: offline, server down, or timed out. Status 0 marks it for callers.
      if (opts.signal?.aborted) throw e;
      throw new ApiError(0, OFFLINE_MESSAGE, null);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      // A guest's token the server no longer accepts (say, one minted before tokens carried
      // a nonce): register again, at most every ten minutes, so the next call works.
      const s = session.get();
      if (res.status === 401 && opts.who === "me" && s.installToken && !s.user && installRejected && Date.now() - lastRecovery > 600_000) {
        lastRecovery = Date.now();
        void installRejected();
      }
      const msg = (json as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
      throw new ApiError(res.status, msg, json);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

export const apiUrl = (path: string) => `${config.apiBaseUrl}${path}`;
