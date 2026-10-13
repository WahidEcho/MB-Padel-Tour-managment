import Link from "next/link";
import { authProviders } from "@/lib/auth/users";
import { ACCEPT_MESSAGES, inviteByToken, readInviteCookie, type AcceptRefusal } from "@/lib/orgs/invites";
import { maskEmail } from "@/lib/orgs/inviteToken";
import { ROLE_LABELS } from "@/lib/orgs/roles";
import { staffHome } from "@/lib/auth/staffRedirect";
import { permissionRole } from "@/lib/orgs/roles";

export const dynamic = "force-dynamic";

const EXTRA: Record<string, string> = {
  busy: "Too many attempts. Wait a few minutes and open the link again.",
  none: "Open the invite link from your email to continue.",
};

/**
 * An invite to an organisation's staff, opened from its email link (the token is
 * in an httpOnly cookie by now: /invite/open). The person signs in with the
 * invited address; the sign-in itself accepts the invite (src/lib/orgs/invites.ts).
 */
export default async function InvitePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const view = await inviteByToken(await readInviteCookie());
  const providers = await authProviders();
  const errorText = error ? (ACCEPT_MESSAGES[error as AcceptRefusal] ?? EXTRA[error] ?? ACCEPT_MESSAGES.invalid) : null;
  const pending = view && view.state === "pending" && view.org.status === "approved";
  const blocked = view && !pending ? ACCEPT_MESSAGES[view.state === "accepted" ? "used" : view.state === "pending" ? "org_unavailable" : view.state] : null;
  const next = view ? staffHome(permissionRole(view.invite.role)) : "/admin/tournaments";

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card w-full max-w-sm space-y-4 p-6" data-testid="invite">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Move Score</p>
          <h1 className="text-xl font-bold">{pending ? `Join ${view.org.name}` : "Staff invitation"}</h1>
        </div>
        {errorText && (
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-semibold text-danger" data-testid="invite-error">{errorText}</p>
        )}
        {!view && !errorText && <p className="text-sm text-muted">{EXTRA.none}</p>}
        {blocked && !errorText && <p className="text-sm text-muted" data-testid="invite-state">{blocked}</p>}
        {pending && (
          <>
            <p className="text-sm">
              You are invited as <strong>{ROLE_LABELS[view.invite.role].toLowerCase()}</strong>. Sign in with{" "}
              <strong>{maskEmail(view.invite.email)}</strong>, the address the invite was sent to. The invite works once.
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
        <p className="text-center text-xs text-muted">
          <Link href="/login" className="hover:text-foreground">Staff login</Link>
        </p>
      </div>
    </main>
  );
}
