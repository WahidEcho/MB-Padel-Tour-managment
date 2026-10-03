/**
 * Browser sign-in (Google through Supabase Auth, PKCE). Pure helpers shared by
 * the server and the Move Score app (through move-score-app/src/core): no Node,
 * browser or Next.js APIs here.
 *
 * The flow: the app makes a one-time code verifier and sends only its SHA-256
 * challenge. It opens the server's start route in the in-app browser sheet; the
 * server checks the request and redirects to Supabase's authorize URL; Google
 * and Supabase send the browser back to the app's redirect with `?code=`. The
 * app hands code + verifier to the server, which trades them for a session.
 */

/** Providers the app signs in with through the browser sheet. */
export const BROWSER_SIGN_IN_PROVIDERS = ["google"] as const;
export type BrowserSignInProvider = (typeof BROWSER_SIGN_IN_PROVIDERS)[number];

export const isBrowserSignInProvider = (p: unknown): p is BrowserSignInProvider =>
  typeof p === "string" && (BROWSER_SIGN_IN_PROVIDERS as readonly string[]).includes(p);

/** RFC 7636: 43–128 unreserved characters. */
export const isCodeVerifier = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(s);

/** A base64url SHA-256 digest, unpadded: exactly 43 characters. */
export const isCodeChallenge = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);

/**
 * Where the browser may send the code back to: the app's own scheme (store and
 * development builds), Expo Go (`exp://…/--/auth/callback`), or a local web preview.
 * Supabase's redirect allow-list is the second, authoritative check.
 */
export function isAppRedirect(redirectTo: unknown): redirectTo is string {
  if (typeof redirectTo !== "string" || redirectTo.length > 300) return false;
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(redirectTo);
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  const host = m[2]!.toLowerCase().replace(/:\d+$/, "");
  if (scheme === "movescore" || scheme === "exp" || scheme === "exps") return true;
  if (scheme === "http" || scheme === "https") return host === "localhost" || host === "127.0.0.1";
  return false;
}

/** Supabase's authorize URL for a PKCE sign-in. */
export function supabaseAuthorizeUrl(
  supabaseUrl: string,
  o: { provider: BrowserSignInProvider; redirectTo: string; codeChallenge: string },
): string {
  const q = [
    `provider=${encodeURIComponent(o.provider)}`,
    `redirect_to=${encodeURIComponent(o.redirectTo)}`,
    `code_challenge=${encodeURIComponent(o.codeChallenge)}`,
    "code_challenge_method=s256",
    // Lets someone with two Google accounts pick one instead of being signed in silently.
    ...(o.provider === "google" ? ["prompt=select_account"] : []),
  ];
  return `${supabaseUrl.replace(/\/$/, "")}/auth/v1/authorize?${q.join("&")}`;
}

/** The app's redirect with an error attached, so the app shows it like any other failure. */
export function redirectWithError(redirectTo: string, error: string, description: string): string {
  const sep = redirectTo.includes("?") ? "&" : "?";
  return `${redirectTo}${sep}error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(description)}`;
}

export interface AuthRedirect {
  code: string | null;
  error: string | null;
  errorDescription: string | null;
}

function params(part: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of part.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? "" : pair.slice(i + 1);
    try {
      out.set(decodeURIComponent(k.replace(/\+/g, " ")), decodeURIComponent(v.replace(/\+/g, " ")));
    } catch {
      /* malformed escape: skip */
    }
  }
  return out;
}

/**
 * Reads where the browser came back to. Supabase puts the PKCE code in the query
 * and errors in the query or the fragment, depending on where the flow failed.
 */
export function readAuthRedirect(url: string): AuthRedirect {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt + 1);
  const qAt = beforeHash.indexOf("?");
  const query = params(qAt < 0 ? "" : beforeHash.slice(qAt + 1));
  const frag = params(hash);
  const get = (k: string) => query.get(k) ?? frag.get(k) ?? null;
  return { code: query.get("code") || null, error: get("error") || get("error_code"), errorDescription: get("error_description") };
}

/** A sentence to show for a failed browser sign-in; null when the person simply backed out. */
export function authRedirectMessage(r: Pick<AuthRedirect, "error" | "errorDescription">): string | null {
  if (!r.error) return null;
  // Google's "Cancel" on its consent screen comes back as access_denied.
  if (r.error === "access_denied") return null;
  const d = (r.errorDescription ?? "").trim();
  return d ? `Sign-in did not finish: ${d.replace(/\.$/, "")}.` : "Sign-in did not finish. Try again.";
}
