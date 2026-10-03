/**
 * When a Move Score session really is over. Pure, shared by the server's refresh
 * route and the app (through move-score-app/src/core).
 *
 * The app keeps a person signed in until they sign out. It lets go of the session
 * only when the server says, definitively, that Supabase refused the refresh token
 * (revoked, already rotated away, its session ended, the user gone). A network
 * error, a timeout, a rate limit or a 5xx never signs anyone out: the app keeps the
 * tokens and tries again later.
 */

/** The `code` the refresh route answers with when the refresh token is no longer valid. */
export const SESSION_REVOKED = "session_revoked";
/** The `code` the refresh route answers with when Supabase could not be asked (try again). */
export const SESSION_RETRY = "session_retry";

// Supabase Auth's error codes for a refresh token that will never work again.
const DEFINITIVE_CODES = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
  "bad_jwt",
]);

export interface AuthErrorLike {
  name?: string;
  status?: number;
  code?: string;
  message?: string;
}

/**
 * What a failed refresh means. Supabase answers a dead refresh token with a 4xx
 * API error ("Invalid Refresh Token: …"); anything else (no answer, 429, 5xx, an
 * error supabase-js marks retryable) is temporary.
 */
export function refreshVerdict(error: AuthErrorLike | null | undefined): "revoked" | "retry" {
  if (!error) return "retry";
  if (error.name === "AuthRetryableFetchError") return "retry";
  const status = error.status ?? 0;
  if (error.code && DEFINITIVE_CODES.has(error.code)) return "revoked";
  if (status === 429 || status === 0 || status >= 500) return "retry";
  if (status >= 400 && status < 500 && /refresh token|session/i.test(error.message ?? "")) return "revoked";
  return status === 400 || status === 401 || status === 403 || status === 404 ? "revoked" : "retry";
}

/** For the app: whether a refresh answer means "signed out for good". */
export function isSessionRevoked(status: number, body: unknown): boolean {
  return status === 401 && (body as { code?: unknown } | null)?.code === SESSION_REVOKED;
}

/** Seconds before expiry at which the app refreshes ahead of time. */
export const REFRESH_AHEAD_SECONDS = 5 * 60;
