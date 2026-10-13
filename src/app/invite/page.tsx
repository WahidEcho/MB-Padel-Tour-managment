import Link from "next/link";
import { authProviders } from "@/lib/auth/users";
import { ACCEPT_MESSAGES, inviteByToken, readInviteConfirm, readInviteCookie, type AcceptRefusal } from "@/lib/orgs/invites";
import { maskEmail } from "@/lib/orgs/inviteToken";
import { ROLE_LABELS } from "@/lib/orgs/roles";

export const dynamic = "force-dynamic";

const EXTRA: Record<string, string> = {
  busy: "Too many attempts. Wait a few minutes and open the link again.",
  none: "Open the invite link from your email to continue.",
};

/**
 * An invite to an organisation's staff, opened from its email link (the token is
 * in an httpOnly cookie by now: /invite/open). Two steps:
 * 1. The person signs in with the invited address (Google, or email + password).
 *    A sign-in never accepts anything by itself.
 * 2. Back here, signed in as the invited address: "Join <organisation> as
 *    <role>?" with Accept (POST /invite/accept) and Not now (POST /invite/decline).
 * Anyone can also forget the invite in this browser.
 */
export default async function InvitePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const [token, confirm] = await Promise.all([readInviteCookie(), readInviteConfirm()]);
  const view = await inviteByToken(token);
  const providers = await authProviders();
  const errorText = error ? (ACCEPT_MESSAGES[error as AcceptRefusal] ?? EXTRA[error] ?? ACCEPT_MESSAGES.invalid) : null;
  const pending = view && view.state === "pending" && view.org.status === "approved";
  const blocked = view && !pending ? ACCEPT_MESSAGES[view.state === "accepted" ? "used" : view.state === "pending" ? "org_unavailable" : view.state] : null;
  // Signed in just now as the invited address, for this very invite: ask.
  const ask = pending && confirm && confirm.inviteId === view.invite.id && confirm.email === view.invite.email;
  const role = view ? ROLE_LABELS[view.invite.role].toLowerCase() : "";
  // After signing in, the sign-in itself comes back here to ask.
  const next = "/invite";

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card w-full max-w-sm space-y-4 p-6" data-testid="invite">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Move Score</p>
          <h1 className="text-xl font-bold">{ask ? `Join ${view.org.name} as ${role}?` : pending ? `Join ${view.org.name}` : "Staff invitation"}</h1>
        </div>
        {errorText && (
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-semibold text-danger" data-testid="invite-error">{errorText}</p>
        )}
        {!view && !errorText && <p className="text-sm text-muted">{EXTRA.none}</p>}
        {blocked && !errorText && <p className="text-sm text-muted" data-testid="invite-state">{blocked}</p>}
        {ask && (
          <div className="space-y-3" data-testid="invite-ask">
            <p className="text-sm">
              You are signed in as <strong>{maskEmail(view.invite.email)}</strong>. Accept to join <strong>{view.org.name}</strong> on Move
              Score as <strong>{role}</strong>.
            </p>
            <form method="post" action="/invite/accept">
              <button type="submit" className="btn-primary w-full justify-center py-2.5 text-sm" data-testid="invite-accept">
                Accept
              </button>
            </form>
            <form method="post" action="/invite/decline">
              <button type="submit" className="btn-secondary w-full justify-center py-2.5 text-sm" data-testid="invite-decline">
                Not now
              </button>
            </form>
          </div>
        )}
        {pending && !ask && (
          <>
            <p className="text-sm">
              You are invited as <strong>{role}</strong>. Sign in with <strong>{maskEmail(view.invite.email)}</strong>, the address the
              invite was sent to; you will be asked to confirm. The invite works once.
            </p>
            {providers.google && (
              <a href={`/staff/auth/google?next=${encodeURIComponent(next)}`} className="btn-primary w-full justify-center py-2.5 text-sm">
                Continue with Google
              </a>
            )}
            <Link href={`/login?next=${encodeURIComponent(next)}`} className="btn-secondary w-full justify-center py-2.5 text-sm">
              Sign in with email and password
            </Link>
            <p className="text-xs text-muted">
              No Move Score account with this address yet? Continue with Google, or create one in the Move Score app with
              this email, then come back to this page.
            </p>
          </>
        )}
        {view && !ask && (
          <form method="post" action="/invite/decline">
            <button type="submit" className="w-full text-center text-xs text-muted hover:text-foreground" data-testid="invite-forget">
              Not you? Forget this invitation on this device
            </button>
          </form>
        )}
        <p className="text-center text-xs text-muted">
          <Link href="/login" className="hover:text-foreground">Staff login</Link>
        </p>
      </div>
    </main>
  );
}
