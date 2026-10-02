import type { Metadata } from "next";
import { Bullets, InlineLink, Mail, OPERATOR, OPERATOR_SITE, PageTitle, Section, Updated } from "../legal";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "The terms for using the Move Score app and service.",
};

export default function Terms() {
  return (
    <>
      <PageTitle
        eyebrow="Move Score"
        title="Terms of use"
        intro={
          <p>
            These terms cover the Move Score app and service, provided by {OPERATOR} (
            <a href={OPERATOR_SITE} className="underline">mbeg.org</a>). By using Move Score you agree to them. Please also read
            the <InlineLink href="/movescore/privacy">privacy policy</InlineLink>.
          </p>
        }
      />
      <Updated />

      <Section title="1. The service">
        <p>
          Move Score shows live scores, the order of play, draws, standings and alerts for events run on the {OPERATOR}{" "}
          tournament platform, and lets you follow players and teams and collect an event pass. It is free and has no
          purchases or ads.
        </p>
        <p>
          Scores and times are entered by event officials and may be delayed, corrected or changed by the organiser. The
          official result is the one announced by the event. Do not rely on Move Score for betting or any decision where a
          delay or error could cause you a loss.
        </p>
      </Section>

      <Section title="2. Accounts">
        <p>
          You can use Move Score without an account. Accounts, through Sign in with Apple or Google, are for people aged 16 and
          over. You are responsible for activity under your account and can delete it at any time in the app (
          <InlineLink href="/movescore/delete-account">how</InlineLink>).
        </p>
      </Section>

      <Section title="3. Officials">
        <p>
          Referee and staff features are only for officials authorised by the event organiser. Access codes are personal to the
          event; do not share them. Scores entered under a code are recorded with that official role.
        </p>
      </Section>

      <Section title="4. Fair use">
        <p>You agree not to:</p>
        <Bullets
          items={[
            "use automated means to collect data from the service, overload it, or flood cheers or other counters;",
            "share, fake or reuse venue codes to stamp a pass for a day you were not at the event;",
            "put offensive or misleading text, or someone else's name without permission, on your event pass;",
            "access officials' features without authorisation, or try to get around security or rate limits;",
            "copy, modify or reverse engineer the app except where the law allows it.",
          ]}
        />
        <p>We may limit or suspend access for anyone who breaks these rules.</p>
      </Section>

      <Section title="5. Content and names">
        <p>
          The app, its design and software belong to {OPERATOR}. Event names, logos, team names, flags and sponsor marks belong
          to their owners and are shown to identify the events. Player names and results are shown as published by the event
          organiser. Score cards you share are for personal, non-commercial use.
        </p>
      </Section>

      <Section title="6. Availability and changes">
        <p>
          We work to keep Move Score running during events but cannot promise it will always be available, error-free or
          compatible with every device. We may change, add or remove features, and may ask you to update the app to keep using
          it.
        </p>
      </Section>

      <Section title="7. Liability">
        <p>
          Move Score is provided &ldquo;as is&rdquo;. To the extent the law allows, {OPERATOR} is not liable for indirect or
          consequential losses, or for losses caused by delayed, missing or incorrect scores, times or alerts. Nothing in these
          terms limits rights you have under consumer law that cannot be excluded.
        </p>
      </Section>

      <Section title="8. App stores">
        <p>
          These terms are between you and {OPERATOR}, not Apple or Google. Apple and Google have no obligation to provide
          maintenance or support for Move Score and are not responsible for any claims relating to it. If you downloaded the app
          from the App Store, Apple and its subsidiaries are third-party beneficiaries of these terms and may enforce them. Your
          use must also follow the store&apos;s own terms.
        </p>
      </Section>

      <Section title="9. Ending and changes to these terms">
        <p>
          You can stop using Move Score at any time by deleting the app (and your account, if you have one). If we change these
          terms we will update the date above and, for significant changes, tell you in the app. Continuing to use Move Score
          after a change means you accept it.
        </p>
      </Section>

      <Section title="10. Law and contact">
        <p>
          These terms are governed by the laws of the Arab Republic of Egypt, without affecting mandatory consumer protections
          where you live. Questions: <Mail subject="Move Score terms" />.
        </p>
      </Section>
    </>
  );
}
