/**
 * Where a staff sign-in may send the browser afterwards. Pure.
 *
 * `next` comes from the query string, so it is only ever a path on this site:
 * it must start with one "/", and never "//" or "/\" (which browsers treat as
 * another host), carry no control characters, and stay short.
 */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== "string" || next.length === 0 || next.length > 300) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return null;
  return next;
}

/** Each role's landing page. */
export function staffHome(role: string): string {
  if (role === "referee") return "/referee";
  if (role === "operator") return "/operator";
  return "/admin/tournaments";
}

/** The sign-in page's messages, by the `error` it is sent back with. */
export const LOGIN_ERRORS: Record<string, string> = {
  "1": "Wrong access code. Try again.",
  "2": "Too many attempts. Wait 15 minutes and try again.",
  wrong_code: "Wrong access code. Try again.",
  bad_login: "Email or password is incorrect.",
  email_not_confirmed: "Confirm your email first: open the link we sent you when you signed up in Move Score.",
  no_org: "This account is not a member of any organisation yet. Ask your organisation's owner to invite you.",
  signin_failed: "Sign-in did not finish. Try again.",
  google_off: "Google sign-in is not switched on yet.",
  code_revoked: "This event code was revoked. Ask the organiser for a new code.",
  code_expired: "This event code has expired. Ask the organiser for a new code.",
  membership_ended: "Your access to this organisation has ended. Ask its owner if this is a mistake.",
  org_suspended: "This organisation is suspended. Contact Move Beyond.",
  org_pending: "This organisation is not approved yet.",
  unavailable: "Staff sign-in is not available right now.",
  pin_required: "This code needs your 4-digit referee PIN.",
  wrong_pin: "Wrong PIN. Check the 4 digits the organiser gave you.",
  pin_locked: "Too many wrong PINs for this referee: locked for 5 minutes. Other referees can still sign in.",
  pin_paused: "Too many wrong referee PINs at this organisation: PIN sign-in on a new device is paused for a while and the organiser has been told. A phone or browser you signed in on today still works.",
  pin_busy: "Too many PIN attempts from this network. Wait a few minutes and try again.",
  pick_name: "Pick your name from the list, then type your PIN.",
  pin_expired: "That took too long. Enter the court code again.",
  referee_ended: "Your referee sign-in has ended. Sign in again with the court code and your PIN.",
};
