import type { Metadata } from "next";
import { Bullets, InlineLink, Mail, OPERATOR, PageTitle, Section } from "../legal";

export const metadata: Metadata = {
  title: "Delete your account",
  description: "How to delete your Move Score account and data, in the app or by email.",
};

/** Linked from the store listings as the account deletion page (App Store and Google Play data safety). */
export default function DeleteAccount() {
  return (
    <>
      <PageTitle
        eyebrow="Move Score"
        title="Delete your account and data"
        intro={<p>You can delete your Move Score account from inside the app at any time. It takes a few seconds and cannot be undone.</p>}
      />

      <Section title="In the app">
        <ol className="list-decimal space-y-1.5 pl-5 marker:text-muted">
          <li>Open Move Score and go to the <strong>Discover</strong> tab.</li>
          <li>Tap <strong>Account</strong> at the top right.</li>
          <li>Under <strong>Sign in</strong>, tap <strong>Delete account</strong>.</li>
          <li>Tap <strong>Delete</strong> to confirm.</li>
        </ol>
      </Section>

      <Section title="What is deleted">
        <Bullets
          items={[
            "Your account record: display name, sign-in provider and age confirmation.",
            "Everything you followed and starred with the account.",
            "Your event passes, with their stamps, pins, name and nation.",
            "The link between your account and your phones (alerts on the phone keep working as a guest until you turn them off).",
            "Your Sign in with Apple authorisation is revoked with Apple. The sign-in identity, including your email address, is removed from our sign-in provider within 30 days.",
          ]}
        />
        <p>
          Not deleted: cheer totals (they hold no personal data) and, for event officials, the scores entered during matches,
          which are part of the event&apos;s results.
        </p>
      </Section>

      <Section title="Without an account (guest)">
        <p>
          A guest has no account to delete. Your follows and pass are linked only to a random number for your phone. To remove
          them, turn off alerts in Account, then delete the app; the push token is removed once Apple or Google tell us it no
          longer works. To have the rest erased, email us with your pass number (shown on your pass as &ldquo;No.&rdquo;) and
          the event, and we will delete it.
        </p>
      </Section>

      <Section title="If you cannot use the app">
        <p>
          Email <Mail subject="Delete my Move Score account" /> from the address you sign in with (Apple, Google or email; for a
          hidden Apple address, write from any address and tell us the date you signed up). {OPERATOR} confirms the request and
          deletes the account and its data within 30 days, and replies when it is done.
        </p>
        <p className="text-sm text-muted">
          More about what Move Score keeps: <InlineLink href="/movescore/privacy">privacy policy</InlineLink>.
        </p>
      </Section>
    </>
  );
}
