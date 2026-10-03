import type { Metadata } from "next";
import { InlineLink, Mail, OPERATOR, PageTitle } from "./legal";

export const metadata: Metadata = {
  title: { absolute: "Move Score: live scores for the events you follow" },
  description: "Live scores, order of play, draws and alerts for tennis events, from the people running them.",
};

const FEATURES: [string, string][] = [
  ["Every court, live", "Point-by-point scores straight from the umpire's phone, with the order of play, draws and standings for the whole event."],
  ["Follow who matters", "Star players, nations and matches. Following works without an account."],
  ["Alerts you choose", "A court or time is set, play starts, a match finishes. Each kind can be turned off on its own."],
  ["Lock screen scores", "On iPhone, a match you follow can stay on the lock screen while it is played, where the event offers it."],
  ["Your event pass", "A collectible pass for each event. Scan the code at the venue to stamp the days you were there."],
  ["Made for the venue", "Big type, dark and light themes, reduced motion, and it keeps working when the signal drops."],
];

export default function MoveScoreHome() {
  return (
    <>
      <PageTitle
        eyebrow="Move Score"
        title="Every court. Every point."
        intro={
          <p>
            Move Score is the companion app for tennis events run on the {OPERATOR} tournament platform: live scores, the order
            of play, draws and alerts for the players and teams you follow, in one place.
          </p>
        }
      />

      <ul className="grid gap-3 sm:grid-cols-2">
        {FEATURES.map(([title, body]) => (
          <li key={title} className="card space-y-1">
            <p className="font-bold">{title}</p>
            <p className="text-sm text-muted">{body}</p>
          </li>
        ))}
      </ul>

      <section className="space-y-2 text-[15px] leading-relaxed">
        <h2 className="text-xl font-bold">Private by design</h2>
        <p className="text-foreground/90">
          No ads, no tracking and no location. You can use every part of Move Score without an account; signing in only keeps your follows and pass when you change phones. Read the <InlineLink href="/movescore/privacy">privacy policy</InlineLink>.
        </p>
      </section>

      <section className="space-y-2 text-[15px] leading-relaxed">
        <h2 className="text-xl font-bold">Officials</h2>
        <p className="text-foreground/90">
          Referees and umpires score matches from the same app: open <strong>Account → Referee sign-in</strong> and enter the
          access code from the event organiser.
        </p>
      </section>

      <section className="space-y-2 text-[15px] leading-relaxed">
        <h2 className="text-xl font-bold">Help</h2>
        <p className="text-foreground/90">
          See <InlineLink href="/movescore/support">support and common questions</InlineLink>, or write to <Mail subject="Move Score" />.
        </p>
      </section>
    </>
  );
}
