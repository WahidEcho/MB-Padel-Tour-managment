import type { Metadata } from "next";
import { Bullets, InlineLink, Mail, OPERATOR, OPERATOR_SITE, PageTitle, Section, Updated } from "../legal";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What the Move Score app collects, why, who processes it, how long it is kept and how to delete it.",
};

/**
 * Written from what the app and its API actually do (move-score-app/src,
 * src/app/api/mobile/v1, supabase/migrations/0015_move_score_mobile.sql). If any
 * of those start collecting something new, this page changes in the same commit.
 */
export default function PrivacyPolicy() {
  return (
    <>
      <PageTitle
        eyebrow="Move Score"
        title="Privacy policy"
        intro={
          <p>
            This policy explains what the Move Score app (iPhone, iPad and Android) and the Move Score service collect, why,
            and what you can do about it. Move Score is operated by {OPERATOR} (<a href={OPERATOR_SITE} className="underline">mbeg.org</a>),
            which is responsible for your data.
          </p>
        }
      />
      <Updated />

      <Section title="The short version">
        <Bullets
          items={[
            "No ads, no advertising identifier, no tracking across other apps or websites, and no third-party analytics.",
            "No location. The app reads your phone's time zone setting so match times show in your local time; it never asks for GPS or location permission.",
            "You do not need an account. Without one, your follows and pass are linked to a random number the app makes for your phone, not to you.",
            "The camera is only used, when you choose, to read the venue QR code. Images stay on your phone.",
            "We never sell your data.",
          ]}
        />
      </Section>

      <Section title="What we collect and why">
        <h3 className="font-semibold">1. Your phone (every user)</h3>
        <p>
          When the app first opens it creates a random <strong>installation ID</strong> and registers your phone with our server
          together with: the platform (iOS or Android), the app version, your time zone and language setting, and when the app
          was last used. This lets the app keep your follows and pass, and send alerts to the right phone. It contains no name,
          email, phone number or device serial.
        </p>
        <p>
          If you turn alerts on, we also store the <strong>push token</strong> Apple or Google gives the app, and your alert
          choices (for example &ldquo;starting soon&rdquo; or &ldquo;results&rdquo;). If you keep a match on your iPhone lock
          screen, we store a separate push token for that one Live Activity, so its score can be updated; it ends when the match
          does.
        </p>

        <h3 className="font-semibold">2. What you follow</h3>
        <p>
          The players, nations, matches, ties, tournaments and events you follow or star, linked to your installation ID (or to
          your account if you sign in). We use them to show your Following feed and to decide which alerts to send you.
        </p>

        <h3 className="font-semibold">3. Your event pass</h3>
        <p>
          Each event can give you a collectible pass. We store its number and edition, the nation you choose for it (optional),
          the name you type on it (optional, up to 40 characters; a first name or nickname is enough), the days it was stamped
          and the nation pins you collected.
        </p>
        <p>
          To stamp a day you scan the code shown at the venue. The camera image is processed on your phone; only the code it
          reads is sent to us. To check the code was scanned at the event, our hosting provider tells us the country your
          network connection comes from; we compare it with the event&apos;s country and do not store it.
        </p>

        <h3 className="font-semibold">4. Cheers</h3>
        <p>
          When you tap to cheer for a team we add your taps to that team&apos;s total. Only the totals are stored. Your
          installation ID is used for a short time to limit how many cheers one phone can send.
        </p>

        <h3 className="font-semibold">5. An account (optional, 16 and over)</h3>
        <p>
          If you sign in with Apple or Google, the provider gives us an account identifier, your email address (Apple may give a
          private relay address instead) and, if you choose to share it, your name. We keep the name you share as your display
          name, which provider you used and the date you confirmed you are 16 or over. Your email is held by our sign-in
          provider and is not shown in the app or used for marketing. For Sign in with Apple we also keep an encrypted Apple
          token whose only use is to revoke your Apple sign-in when you delete your account. Your follows and pass then move with
          you to a new phone.
        </p>

        <h3 className="font-semibold">6. Event officials</h3>
        <p>
          Referees and umpires sign in with an access code from the event organiser. Scores they enter, with the time and the
          official role that entered them, become part of the event&apos;s public results and audit trail.
        </p>

        <h3 className="font-semibold">7. Crash reports (when enabled)</h3>
        <p>
          If crash reporting is switched on for a release, the app sends error reports to Sentry: what went wrong, the app
          version, the screen, and the phone model and operating system version, plus timing data for a small sample of
          sessions. Sending personal data is turned off: reports contain no names, emails, codes or tokens, and web addresses
          are stripped of their parameters.
        </p>

        <h3 className="font-semibold">8. Abuse protection and server logs</h3>
        <p>
          To stop automated abuse, our server counts requests from each network address over short windows (minutes to an hour)
          for sign-in and phone registration; the counters are deleted soon after. Our hosting provider keeps standard request logs (address, time, page requested)
          for a limited period for security and troubleshooting.
        </p>
      </Section>

      <Section title="What we do not collect">
        <Bullets
          items={[
            "Location (precise or approximate), contacts, photos or files from your phone.",
            "Microphone or audio. The app has no microphone permission.",
            "Advertising identifiers (IDFA / Android advertising ID) or any data for advertising.",
            "Health, financial or payment information. Move Score has no purchases.",
          ]}
        />
        <p>
          When you share a score card, the image is made on your phone and goes only to the app you pick (for example Instagram
          or WhatsApp). That app&apos;s own privacy policy then applies.
        </p>
      </Section>

      <Section title="Tracking">
        <p>
          Move Score does not track you. We do not link data from the app with data from other companies&apos; apps, websites or
          offline sources for advertising or measurement, and we do not share data with data brokers.
        </p>
      </Section>

      <Section title="Who processes data for us">
        <p>Only the service providers needed to run Move Score, each bound to use the data only on our instructions:</p>
        <Bullets
          items={[
            "Supabase: database and sign-in (data stored in the European Union).",
            "Vercel: hosting of the Move Score server and website.",
            "Expo, Apple Push Notification service and Google Firebase Cloud Messaging: delivering alerts and lock-screen scores to your phone.",
            "Apple and Google: Sign in with Apple and Google Sign-In, only if you use them.",
            "Sentry: crash reports, only when enabled for a release.",
          ]}
        />
        <p>
          Some of these providers process data outside your country, including in the United States. We rely on their
          contractual safeguards for those transfers. We may disclose data if the law requires it.
        </p>
      </Section>

      <Section title="How long we keep it">
        <Bullets
          items={[
            "Phone registration, follows and pass: while you use the app. A push token is removed as soon as Apple or Google tell us it no longer works (for example after you delete the app).",
            "Account data: until you delete your account. Deleting it removes your follows, passes and account record straight away and revokes Sign in with Apple; the sign-in identity itself is removed within 30 days.",
            "Lock-screen tokens: until the match ends.",
            "Cheer totals and officials' scores: kept as part of the event's results.",
            "Request counters for abuse protection: deleted within a day or two. Crash reports: up to 90 days.",
          ]}
        />
      </Section>

      <Section id="choices" title="Your choices and rights">
        <Bullets
          items={[
            "Alerts: turn any kind off in Account, or turn them all off in your phone's settings.",
            "Camera: allowed only when you scan, and can be withdrawn in your phone's settings at any time.",
            <>
              Delete your account in the app (Account → Delete account). See <InlineLink href="/movescore/delete-account">how to delete your account and data</InlineLink>, including without an account.
            </>,
            "You can ask us for a copy of your data, to correct it, or to delete it, and you can object to how we use it.",
          ]}
        />
        <p>
          Write to <Mail subject="Move Score privacy request" />. We answer within 30 days. If you are unhappy with our answer you
          can complain to the data protection authority where you live.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Accounts are for people aged 16 and over; the app asks before offering sign-in. Younger fans can use every feature as
          a guest, which does not ask for a name or email. If you believe a child under 16 has created an account, contact us
          and we will delete it.
        </p>
      </Section>

      <Section title="Security">
        <p>
          All traffic is encrypted (HTTPS). Session tokens and the installation ID are kept in your phone&apos;s secure keychain.
          Access codes are checked on the server and never stored in the app.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>
          If we change this policy we will update the date above, and tell you in the app if the change is significant.
          Questions: <Mail subject="Move Score privacy" />, {OPERATOR}, <a href={OPERATOR_SITE} className="underline">mbeg.org</a>.
        </p>
      </Section>
    </>
  );
}
