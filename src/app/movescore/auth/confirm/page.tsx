import type { Metadata } from "next";
import { APP_CONFIRMED_LINK } from "@/lib/auth/accounts";
import { confirmFromLink } from "@/lib/auth/links";
import { PageTitle } from "../../legal";
import { FragmentFinish, OpenApp } from "./parts";

export const metadata: Metadata = {
  title: "Confirm your email",
  robots: { index: false },
};

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * Where the confirmation emails land: `?token_hash=…&type=email|signup|magiclink|email_change|invite`.
 * The token is verified here, on the server, so the email is confirmed even on a
 * computer or a phone without the app; then the page offers to open Move Score
 * (movescore://auth/confirmed), which takes the person to sign in.
 */
export default async function ConfirmEmail({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const tokenHash = one(q.token_hash);
  const error = one(q.error_description) ?? one(q.error);

  if (tokenHash) {
    const r = await confirmFromLink(tokenHash, one(q.type));
    if (r.ok) return <Confirmed email={r.email} change={r.type === "email_change"} />;
    if (r.reason === "unavailable") {
      return (
        <>
          <PageTitle eyebrow="Move Score" title="Try again in a moment" intro={<p>We couldn&apos;t reach the sign-in service. Reload this page to confirm your email.</p>} />
        </>
      );
    }
    return (
      <>
        <PageTitle
          eyebrow="Move Score"
          title="This link has expired"
          intro={
            <p>
              It may already have been used: if you confirmed a moment ago, you&apos;re done, just sign in in the app. Otherwise open Move Score and send a new
              confirmation email, or type the six-digit code from the newest email.
            </p>
          }
        />
        <OpenApp href={APP_CONFIRMED_LINK} label="Open Move Score" />
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageTitle eyebrow="Move Score" title="Email not confirmed" intro={<p>The link didn&apos;t work: it may have expired or already been used. Open Move Score to send a new one.</p>} />
        <OpenApp href={APP_CONFIRMED_LINK} label="Open Move Score" />
      </>
    );
  }

  // A link that went through Supabase's own /verify: already confirmed; the session is in the fragment.
  return (
    <>
      <Confirmed email={null} change={false} />
      <FragmentFinish />
    </>
  );
}

function Confirmed({ email, change }: { email: string | null; change: boolean }) {
  return (
    <>
      <PageTitle
        eyebrow="Move Score"
        title="Email confirmed — open Move Score"
        intro={
          <p>
            {email ? (
              <>
                <strong>{email}</strong> is confirmed.{" "}
              </>
            ) : (
              "Your email is confirmed. "
            )}
            {change ? "Your registration is complete: sign in with this email and your password from now on." : "Go back to the app and sign in with your email and password."}
          </p>
        }
      />
      <OpenApp href={APP_CONFIRMED_LINK} label="Open Move Score" />
      <p className="text-sm text-muted">No app on this device? That&apos;s fine: the email is confirmed. Sign in on the phone where you use Move Score.</p>
    </>
  );
}
