import type { Metadata } from "next";
import { InlineLink, Mail, PageTitle } from "../legal";

export const metadata: Metadata = {
  title: "Support",
  description: "Help with Move Score: alerts, following, the event pass, referee sign-in and accounts.",
};

const FAQ: [string, React.ReactNode][] = [
  [
    "Do I need an account?",
    <>
      No. Everything works as a guest. Signing in (Apple, Google, or your email and a password) only keeps your follows and
      pass when you change phones, and you stay signed in until you sign out. Players can sign in with the player code the
      tournament sent them. Open <strong>Account</strong> (top right of the Discover tab) to sign in.
    </>,
  ],
  [
    "How do I follow a player, nation or match?",
    <>
      Open a player or a tie and tap <strong>+ Follow</strong>, or star a match. Everything you follow appears in the Following tab.
    </>,
  ],
  [
    "I am not getting alerts.",
    <>
      Open <strong>Account</strong> and turn on <strong>Alerts on this phone</strong>, then check the kinds you want. If the
      switch sends you to Settings, allow notifications for Move Score there. Alerts are only sent for the players, nations
      and matches you follow, and only when the event has published a time or result.
    </>,
  ],
  [
    "How do I stamp my event pass?",
    <>
      Open the <strong>Pass</strong> tab and tap <strong>Scan the venue code</strong>, then point the camera at the code shown on the
      screens at the venue. Each day you scan adds a stamp. The code changes regularly, so a photo of it will not work later.
      If the camera is blocked, allow it for Move Score in your phone&apos;s settings.
    </>,
  ],
  [
    "Can I keep a live score on my lock screen?",
    <>
      On iPhone, where the event offers it, open a live match and tap <strong>Lock screen</strong>. It ends
      by itself when the match finishes.
    </>,
  ],
  [
    "I am a referee or umpire. How do I sign in?",
    <>
      Open <strong>Account</strong> (top right of the Discover tab), scroll to <strong>Staff</strong> and tap{" "}
      <strong>Referee sign-in</strong>. Enter the access code from the event organiser; you then see the matches you can
      score. Scores entered without signal are kept on the phone and sent when the connection returns.
    </>,
  ],
  [
    "A score or time looks wrong.",
    <>
      Scores and times come from the event officials and update within seconds of a correction. Pull down to refresh. If it
      stays wrong, tell the event desk or write to us with the match and the time you saw it.
    </>,
  ],
  [
    "How do I delete my account or data?",
    <>
      In the app: <strong>Account → Delete account</strong>. Full steps, including for guests, are on{" "}
      <InlineLink href="/movescore/delete-account">delete your account</InlineLink>.
    </>,
  ],
];

export default function Support() {
  return (
    <>
      <PageTitle
        eyebrow="Move Score"
        title="Support"
        intro={<p>Answers to common questions. If yours is not here, write to us and we will reply within two working days.</p>}
      />

      <div className="space-y-3">
        {FAQ.map(([q, a]) => (
          <details key={q} className="card group">
            <summary className="cursor-pointer list-none font-semibold marker:hidden">
              <span className="mr-2 inline-block text-accent transition-transform group-open:rotate-90" aria-hidden>
                ›
              </span>
              {q}
            </summary>
            <p className="mt-2 text-[15px] leading-relaxed text-foreground/90">{a}</p>
          </details>
        ))}
      </div>

      <section className="card space-y-2">
        <h2 className="text-xl font-bold">Contact</h2>
        <p className="text-[15px] leading-relaxed text-foreground/90">
          Email <Mail subject="Move Score support" />. Please include your phone model, the app version (shown at the bottom of
          Account) and what you were doing when the problem happened.
        </p>
        <p className="text-sm text-muted">
          See also the <InlineLink href="/movescore/privacy">privacy policy</InlineLink> and{" "}
          <InlineLink href="/movescore/terms">terms of use</InlineLink>.
        </p>
      </section>
    </>
  );
}
