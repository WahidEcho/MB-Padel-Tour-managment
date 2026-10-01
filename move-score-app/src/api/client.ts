/**
 * Talks to the Move Score server. Public reads carry no credentials (so the
 * CDN can share them); personal calls carry the install token and, when signed
 * in, the user's session; referee calls carry the staff token.
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

async function headersFor(who: Who): Promise<Record<string, string>> {
  const s = session.get();
  const h: Record<string, string> = { Accept: "application/json" };
  if (who === "me") {
    if (s.installToken) h["X-Install-Token"] = s.installToken;
    if (s.user) h.Authorization = `Bearer ${await freshUserToken()}`;
    if (s.staff) h["X-Staff-Token"] = s.staff.token;
  }
  if (who === "staff" && s.staff) h.Authorization = `Bearer ${s.staff.token}`;
  return h;
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

export async function api<T>(path: string, opts: { method?: string; body?: unknown; who?: Who; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000);
  opts.signal?.addEventListener("abort", () => ctrl.abort());
  try {
    const res = await fetch(`${config.apiBaseUrl}${path}`, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: { ...(await headersFor(opts.who ?? "public")), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const msg = (json as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
      throw new ApiError(res.status, msg, json);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

export const apiUrl = (path: string) => `${config.apiBaseUrl}${path}`;
