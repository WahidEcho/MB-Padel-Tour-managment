/**
 * Which credentials each kind of call carries. Pure, so it is tested on its own.
 *
 * - public: none (so the CDN can share the answer).
 * - me: the install token and, when signed in, the user's session. Never the staff
 *   token: a phone that once signed in to the referee console must not make its
 *   holder's pass (or anything else personal) a referee's.
 * - staff: the staff token, plus the install token so the server can say which
 *   match this phone holds.
 */
export type Who = "public" | "me" | "staff";

// A match's state is never shared at the CDN. With the install token the server can
// tell this phone whether it holds the scoring lease; it never shows another phone's id.
const MATCH_STATE = /^\/api\/matches\/[^/?]+\/state(\?|$)/;

export function credentialHeaders(who: Who, path: string, c: { installToken: string | null; userToken: string | null; staffToken: string | null }): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (who === "me") {
    if (c.installToken) h["X-Install-Token"] = c.installToken;
    if (c.userToken) h.Authorization = `Bearer ${c.userToken}`;
  }
  if (who === "staff" && c.staffToken) h.Authorization = `Bearer ${c.staffToken}`;
  if ((who === "staff" || MATCH_STATE.test(path)) && c.installToken) h["X-Install-Token"] = c.installToken;
  return h;
}
