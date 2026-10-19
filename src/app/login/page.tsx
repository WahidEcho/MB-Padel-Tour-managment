import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { clientIpFrom } from "@/lib/ratelimit";
import { emailAllowed } from "@/lib/auth/limits";
import { staffLoginAttempt } from "@/lib/staffLogin";
import { pendingInviteFor } from "@/lib/orgs/invites";
import { audit } from "@/lib/audit";
import { authClient, authProviders } from "@/lib/auth/users";
import { getAuthUser, signOutAuth } from "@/lib/auth/accounts";
import { isValidEmail, normalizeEmail } from "@/lib/auth/password";
import { currentStaff, finishStaffSignIn, issueCarry, replacePreviousReferee, setCarryCookie, setStaffCookie, signInWithAccessCode, STAFF_WEB_HOURS, type CodeSignIn } from "@/lib/auth/staff";
import { normalizeEventCode, openEventCode, sealEventCode } from "@/lib/orgs/codes";
import { isLocalHost } from "@/lib/auth";
import { LOGIN_ERRORS, safeNextPath, staffHome } from "@/lib/auth/staffRedirect";
import PendingField from "./PendingField";

export const dynamic = "force-dynamic";

const withNext = (path: string, next: string | null) => (next ? `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}` : path);

/**
 * Referee PINs (migration 0035): a court (or master) code typed here is kept, sealed
 * (AES-GCM under EVENT_CODE_PEPPER, src/lib/orgs/codes.ts), in a five-minute HttpOnly
 * cookie while the page asks for the PIN, so the code is never in a URL.
 */
const PIN_COOKIE_MINUTES = 5;
async function pinCookieName() {
  return isLocalHost((await headers()).get("host")) ? "mb_pin_code" : "__Host-mb_pin_code";
}

/** Signs the browser in with a code that worked (and, for a court or master code, its PIN). */
async function finishCodeLogin(r: Extract<CodeSignIn, { ok: true }>, formData: FormData, previous: Awaited<ReturnType<typeof currentStaff>>) {
  const list = (k: string) => String(formData.get(k) ?? "").split(",").filter(Boolean).slice(0, 25);
  await setStaffCookie(r.token, STAFF_WEB_HOURS);
  const carry = await issueCarry(previous, r.reach, { pending: list("pending"), open: list("open") });
  await setCarryCookie(carry);
  await replacePreviousReferee(previous, Boolean(carry));
  await audit({
    organization_id: r.orgId,
    actor_role: r.role,
    action: "LOGIN",
    entity_type: r.codeId ? "organization_code" : undefined,
    entity_id: r.codeId,
    actor_referee: r.referee,
    new_value: { via: "web", kind: r.kind, ...(r.court ? { court: r.court.name } : {}), ...(r.referee ? { referee: r.referee.name, role: r.referee.role } : {}) },
  });
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; switch?: string; pin?: string; court?: string }>;
}) {
  const { next: rawNext, error, switch: switching, pin: askPin, court: pinCourt } = await searchParams;
  const next = safeNextPath(rawNext);
  const signedIn = await currentStaff();
  // Coming from an invite (next=/invite), a signed-in person may sign in again as the invited address.
  // A referee switching courts types the new court's code while still signed in (the old
  // court's unsent or unfinished matches are carried over by the sign-in).
  if (signedIn && next !== "/invite" && !(switching === "1" && signedIn.kind === "code") && askPin !== "1") redirect(next || staffHome(signedIn.role));
  const providers = await authProviders();

  /** An event code (referees, TV operators) or Move Beyond's shared role password. */
  async function login(formData: FormData) {
    "use server";
    const password = String(formData.get("password") ?? "");
    const nextUrl = safeNextPath(formData.get("next"));
    const ip = clientIpFrom(await headers());
    // Counted before it is checked (atomically); a right code is refunded (src/lib/staffLogin.ts).
    const gate = await staffLoginAttempt(ip, password);
    if (!gate.allowed) redirect(withNext("/login?error=2", nextUrl));
    // Switching courts: this browser's unsent / unfinished matches stay reachable with the
    // old court's code (a carry-over cookie), never new ones (src/lib/auth/staff.ts issueCarry).
    const previous = await currentStaff();
    const r = await signInWithAccessCode(password, STAFF_WEB_HOURS, { ip, via: "web" });
    if (!r.ok) {
      if (r.reason === "unavailable" || r.reason === "pin_required" || r.reason === "wrong_pin" || r.reason === "pin_locked") await gate.refund();
      if (r.reason === "pin_required") {
        // The code is right: keep it (sealed, five minutes) and ask for the referee's PIN.
        const code = normalizeEventCode(password.trim());
        if (code) {
          (await cookies()).set(await pinCookieName(), sealEventCode(code), {
            httpOnly: true,
            sameSite: "strict",
            secure: !isLocalHost((await headers()).get("host")),
            path: "/",
            maxAge: PIN_COOKIE_MINUTES * 60,
          });
          redirect(withNext(`/login?pin=1${r.court ? `&court=${encodeURIComponent(r.court)}` : r.master ? "&court=master" : ""}`, nextUrl));
        }
      }
      redirect(withNext(`/login?error=${r.reason}`, nextUrl));
    }
    await gate.refund();
    await finishCodeLogin(r, formData, previous);
    redirect(nextUrl || staffHome(r.role));
  }

  /** Step two for every referee code (court, whole-event, master): the referee's own 4-digit PIN. */
  async function pinLogin(formData: FormData) {
    "use server";
    const nextUrl = safeNextPath(formData.get("next"));
    const store = await cookies();
    const name = await pinCookieName();
    const code = openEventCode(store.get(name)?.value);
    if (!code) redirect(withNext("/login?error=pin_expired", nextUrl));
    const ip = clientIpFrom(await headers());
    const previous = await currentStaff();
    // The PIN has its own brakes (per code and per address, src/lib/referees/server.ts).
    const r = await signInWithAccessCode(code, STAFF_WEB_HOURS, { ip, via: "web", pin: String(formData.get("pin") ?? "").slice(0, 12) });
    if (!r.ok) {
      const court = String(formData.get("court") ?? "").slice(0, 60);
      if (r.reason === "wrong_pin") redirect(withNext(`/login?pin=1&error=wrong_pin${court ? `&court=${encodeURIComponent(court)}` : ""}`, nextUrl));
      store.set(name, "", { httpOnly: true, sameSite: "strict", secure: !isLocalHost((await headers()).get("host")), path: "/", maxAge: 0 });
      redirect(withNext(`/login?error=${r.reason}`, nextUrl));
    }
    store.set(name, "", { httpOnly: true, sameSite: "strict", secure: !isLocalHost((await headers()).get("host")), path: "/", maxAge: 0 });
    await finishCodeLogin(r, formData, previous);
    redirect(nextUrl || staffHome(r.role));
  }

  /** A personal staff account: email + password (Supabase Auth), checked here once. */
  async function emailLogin(formData: FormData) {
    "use server";
    const nextUrl = safeNextPath(formData.get("next"));
    const email = normalizeEmail(String(formData.get("email") ?? ""));
    const password = String(formData.get("account_password") ?? "").slice(0, 400);
    const ip = clientIpFrom(await headers());
    // Counted before it is checked (atomically); a right password is refunded (src/lib/staffLogin.ts).
    const gate = await staffLoginAttempt(ip);
    // Per address and per (hashed) email, as the app's email sign-in.
    if (!gate.allowed || !(await emailAllowed("staff-email", email, 10, 900))) {
      await gate.refund();
      redirect(withNext("/login?error=2", nextUrl));
    }
    if (!isValidEmail(email) || !password) {
      await gate.refund();
      redirect(withNext("/login?error=bad_login", nextUrl));
    }
    const { data, error: signInError } = await authClient().auth.signInWithPassword({ email, password });
    if (signInError || !data.session) {
      redirect(withNext(`/login?error=${signInError?.code === "email_not_confirmed" ? "email_not_confirmed" : "bad_login"}`, nextUrl));
    }
    await gate.refund();
    // Authoritative: ask Supabase Auth who the session belongs to.
    const me = await getAuthUser(data.session.access_token);
    if (!me.ok || me.data.id !== data.user?.id || me.data.is_anonymous) redirect(withNext("/login?error=signin_failed", nextUrl));
    // An invite opened in this browser is never accepted by the sign-in: when it is this
    // person's, the next page asks "Join … ?"; otherwise the browser forgets it. The
    // sign-in itself goes ahead as usual either way.
    const invite = await pendingInviteFor(me.data);
    const done = await finishStaffSignIn(me.data.id);
    // Our own signed cookie is the staff session; the Supabase one is not kept.
    await signOutAuth(data.session.access_token).catch(() => false);
    if (done.ok) {
      await setStaffCookie(done.token, STAFF_WEB_HOURS);
      await audit({ organization_id: done.org.id, actor_role: done.org.role, action: "LOGIN", new_value: { via: "web", kind: "member", method: "email" } });
    }
    if (invite?.ok) redirect("/invite");
    if (!done.ok) redirect(invite ? `/invite?error=${invite.reason}` : withNext(`/login?error=${done.reason}`, nextUrl));
    const next = nextUrl === "/invite" ? null : nextUrl;
    if (done.choices > 1) redirect(withNext("/staff/orgs", next));
    redirect(next || staffHome(done.org.role === "owner" ? "admin" : done.org.role));
  }

  const message = error ? (LOGIN_ERRORS[error] ?? LOGIN_ERRORS.signin_failed) : null;

  if (askPin === "1") {
    const master = pinCourt === "master";
    const court = !master && pinCourt ? pinCourt.slice(0, 60) : null;
    return (
      // The PIN step is the referee's: it follows the device's light/dark setting like the console.
      <main className="theme-auto flex min-h-screen flex-1 items-center justify-center bg-background p-6 text-foreground">
        <form action={pinLogin} className="card w-full max-w-sm space-y-4 p-6" data-testid="pin-step">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-accent">Move Score</p>
            <h1 className="text-xl font-bold">{master ? "Master referee" : court ? court : "Referee"}</h1>
            <p className="mt-1 text-sm text-muted">Enter your own 4-digit referee PIN. It tells the desk who is scoring.</p>
          </div>
          {message && (
            <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-semibold text-danger" data-testid="login-error">{message}</p>
          )}
          <input type="hidden" name="next" value={next ?? ""} />
          <input type="hidden" name="court" value={pinCourt ?? ""} />
          <PendingField />
          <div>
            <label className="label" htmlFor="pin">Referee PIN</label>
            <input
              id="pin"
              name="pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              required
              autoFocus
              autoComplete="off"
              className="input text-center font-mono text-3xl tracking-[0.6em]"
              placeholder="••••"
            />
          </div>
          <button type="submit" className="btn-primary w-full py-3 text-base">Sign in</button>
          <a href={withNext("/login", next)} className="block text-center text-xs text-muted hover:text-foreground">Use another code</a>
        </form>
      </main>
    );
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Move Score</p>
          <h1 className="text-xl font-bold">Staff Login</h1>
        </div>
        {message && (
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-semibold text-danger" data-testid="login-error">
            {message}
          </p>
        )}

        <section className="card space-y-3 p-6">
          <h2 className="text-sm font-bold">Organisers</h2>
          <p className="text-xs text-muted">Sign in with your own account. You choose the organisation next.</p>
          {providers.google && (
            <a href={withNext("/staff/auth/google", next)} className="btn-secondary w-full justify-center py-2.5 text-sm">
              Continue with Google
            </a>
          )}
          <form action={emailLogin} className="space-y-2">
            <input type="hidden" name="next" value={next ?? ""} />
            <label className="label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required className="input" />
            <label className="label" htmlFor="account_password">Password</label>
            <input id="account_password" name="account_password" type="password" autoComplete="current-password" required className="input" />
            <button type="submit" className="btn-primary w-full py-2.5 text-sm">Sign in</button>
          </form>
          <p className="text-xs text-muted">
            Signed in to Move Score with Apple or a player code? Add an email and password in the app first.
          </p>
        </section>

        <form action={login} className="card space-y-3 p-6">
          <h2 className="text-sm font-bold">Referees and screen operators</h2>
          <p className="text-xs text-muted">Enter the event code your organiser gave you.</p>
          <input type="hidden" name="next" value={next ?? ""} />
          <PendingField />
          <div>
            <label className="label" htmlFor="password">Event code</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="off"
              className="input text-lg"
              placeholder="XXXX-XXXX-XXXX"
            />
          </div>
          <button type="submit" className="btn-primary w-full py-3 text-base">Log in</button>
        </form>
      </div>
    </main>
  );
}
