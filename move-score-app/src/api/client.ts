/**
 * Talks to the Move Score server. Public reads carry no credentials (so the
 * CDN can share them); personal calls carry the install token and, when signed
 * in, the user's session; referee calls carry the staff token (and the install
 * token, so the server can say which match this phone holds).
 */
import { config } from "../config";
import { session, saveUser } from "../state/session";
import { isSessionRevoked } from "@core";
import { credentialHeaders, type Who } from "./headers";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

export const OFFLINE_MESSAGE = "Can't reach Move Score right now. Check your connection and try again.";

/** A message fit to show a person, whatever was thrown. */
export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : OFFLINE_MESSAGE);

/** What each call carries: see headers.ts (personal calls never carry the staff token). */
async function headersFor(who: Who, path: string): Promise<Record<string, string>> {
  const s = session.get();
  const userToken = who === "me" && s.user ? await freshUserToken() : null;
  return credentialHeaders(who, path, { installToken: s.installToken, userToken, staffToken: s.staff?.token ?? null });
}

let installRejected: (() => Promise<void>) | null = null;
let lastRecovery = 0;
/** What to do when a personal call is refused for want of a valid install token (push/register.ts registers again). */
export function onInstallRejected(fn: () => Promise<void>) {
  installRejected = fn;
}

let refreshing: Promise<RefreshOutcome> | null = null;

export type RefreshOutcome = "fresh" | "refreshed" | "revoked" | "failed" | "signed-out";

/**
 * Trades the refresh token for a new session. Refresh tokens are single-use, so
 * concurrent callers share one refresh. The session is dropped only when the
 * server says the refresh token is revoked (401 session_revoked); offline, a
 * timeout, a rate limit or a server error leave it as it is, to try again later.
 *
 * `aheadSeconds`: refresh only if the access token expires within this many seconds.
 */
export async function refreshUserSession(aheadSeconds = 60): Promise<RefreshOutcome> {
  const u = session.get().user;
  if (!u) return "signed-out";
  if (u.expiresAt && u.expiresAt * 1000 - Date.now() > aheadSeconds * 1000) return "fresh";
  if (!refreshing) {
    refreshing = (async (): Promise<RefreshOutcome> => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15_000);
        let res: Response;
        try {
          res = await fetch(`${config.apiBaseUrl}/api/mobile/v1/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken: u.refreshToken }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const body = (await res.json().catch(() => null)) as { accessToken?: string; refreshToken?: string; expiresAt?: number | null; code?: string } | null;
        // Someone signed out (or in as someone else) while this was in flight: leave their session alone.
        const now = session.get().user;
        if (!now || now.id !== u.id || now.refreshToken !== u.refreshToken) return "failed";
        if (isSessionRevoked(res.status, body)) {
          await saveUser(null);
          return "revoked";
        }
        if (!res.ok || !body?.accessToken || !body.refreshToken) return "failed";
        await saveUser({ ...now, accessToken: body.accessToken, refreshToken: body.refreshToken, expiresAt: body.expiresAt ?? null });
        return "refreshed";
      } catch {
        return "failed"; // offline or timed out: keep the session
      } finally {
        setTimeout(() => (refreshing = null), 0);
      }
    })();
  }
  return refreshing;
}

/** The access token to send: refreshed first when it is about to expire. Never signs out on a failed refresh. */
async function freshUserToken(): Promise<string> {
  await refreshUserSession(60);
  return session.get().user?.accessToken ?? "";
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
