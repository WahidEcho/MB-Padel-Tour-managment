import SponsorMarquee from "@/components/SponsorMarquee";
import { Mark, OrbitStage } from "./Orbit";
import type { CairoEdition } from "./cairo";
import { PLAY_STORE_URL, TESTFLIGHT_URL, type Platform } from "./stores";
import { AndroidIcon, AppleIcon } from "./ui";
import "./cairo.css";

/**
 * tour.mbeg.org/app while the Cairo Junior Finals are on (cairo.ts decides): a light page in the
 * events' own colours. Says first which events the app is for, then the three ways to follow them
 * (iPhone, Android, the web pages, with no download), what the app does, and every partner of
 * both events looping along the foot like the court TVs. Nothing here is invented: the claims are
 * what Move Score does at these events. The Orbit design is untouched (Orbit.tsx).
 */
export function CairoEditionPage({ edition, iosLive, platform, displayFont }: { edition: CairoEdition; iosLive: boolean; platform: Platform; displayFont: string }) {
  const ios = (
    <a key="i" className="cx-store" href={iosLive ? "/app/ios" : TESTFLIGHT_URL} style={{ background: "#0b0d18", color: "#ffffff" }}>
      <AppleIcon size={24} />
      <span>
        <small>{iosLive ? "Download on the" : "iPhone · early access"}</small>
        <b>{iosLive ? "App Store" : "Apple TestFlight"}</b>
      </span>
    </a>
  );
  const android = (
    <a key="a" className="cx-store" href={PLAY_STORE_URL} style={{ background: "#FCFC00", color: "#0b0d18" }}>
      <AndroidIcon size={24} />
      <span>
        <small>Get it on</small>
        <b>Google Play</b>
      </span>
    </a>
  );
  const stores = platform === "android" ? [android, ios] : [ios, android];
  const dc = edition.events.find((e) => e.slug.startsWith("davis"));
  const bjk = edition.events.find((e) => e.slug.startsWith("bjk"));

  return (
    <div className="cx-root" style={{ ["--cx-display" as string]: displayFont }}>
      <header className="cx-bar">
        <a href="#top" className="cx-brand" aria-label="Move Score">
          <Mark size={34} ink="#0b0d18" />
          <span>
            <b className="cx-disp">MOVE SCORE</b>
            <small>Live scores · Cairo 2026</small>
          </span>
        </a>
        <a href="#get" className="cx-bar-cta">Get the app</a>
      </header>

      <section id="top" className="cx-hero">
        <div className="cx-art" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/backgrounds/cairo-2026/dc-public.svg" alt="" className="cx-art-l" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/backgrounds/cairo-2026/bjk-public.svg" alt="" className="cx-art-r" />
        </div>
        <div className="cx-hero-in">
          <div className="cx-logos">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/sponsors/cairo-2026/dark/davis-cup-event.png" alt="Davis Cup Junior Finals 2026, Cairo, Egypt" />
            <span aria-hidden />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/sponsors/cairo-2026/dark/bjk-cup-event.png" alt="Billie Jean King Cup Junior Finals 2026, Cairo" />
          </div>
          <p className="cx-kicker">Junior Finals · Cairo, Egypt · 2026</p>
          <h1 className="cx-disp cx-h1">
            Every point.
            <br />
            Live.
          </h1>
          <p className="cx-lede">
            Follow the <b>Davis Cup Junior Finals</b> and the <b>Billie Jean King Cup Junior Finals</b> as they happen: live scores, the order of
            play, line-ups and an alert when your nation is on court. Free on Move Score.
          </p>
          <div id="get" className="cx-stores">{stores}</div>
          <a href="#web" className="cx-nodl">
            No download? Watch live on the web <span aria-hidden>↓</span>
          </a>
        </div>
      </section>

      {/* The turning 3D phone of the Orbit design, in the middle of the page (owner, 31 Oct 2026). */}
      <div className="ms-root cx-stage" style={{ ["--ms-display" as string]: displayFont }}>
        <OrbitStage />
      </div>

      <section id="web" className="cx-sec">
        <p className="cx-kicker">Live scoring on the web</p>
        <h2 className="cx-disp cx-h2">Open it in any browser.</h2>
        <p className="cx-sub">Every tie, every rubber, point by point. Nothing to install.</p>
        <div className="cx-events">
          {[dc && { ...dc, cls: "cx-ev-dc", art: "/backgrounds/cairo-2026/dc-public.svg" }, bjk && { ...bjk, cls: "cx-ev-bjk", art: "/backgrounds/cairo-2026/bjk-public.svg" }]
            .filter((e): e is NonNullable<typeof e> => Boolean(e))
            .map((e) => (
              <a key={e.slug} href={`/t/${e.slug}`} className={`cx-ev ${e.cls}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={e.art} alt="" aria-hidden className="cx-ev-art" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={e.logo} alt="" className="cx-ev-logo" />
                <span className="cx-ev-name">{e.name}</span>
                <span className="cx-ev-go">
                  Live scores <span aria-hidden>→</span>
                </span>
                <span className="cx-ev-url">tour.mbeg.org/t/{e.slug}</span>
              </a>
            ))}
        </div>
      </section>

      <section className="cx-sec">
        <p className="cx-kicker">Every way to follow</p>
        <h2 className="cx-disp cx-h2">On your phone, on the web, at the venue.</h2>
        <div className="cx-ways">
          <a href={iosLive ? "/app/ios" : TESTFLIGHT_URL} className="cx-way">
            <AppleIcon size={26} />
            <b>Move Score for iPhone</b>
            <span>{iosLive ? "On the App Store" : "Early access with TestFlight"}</span>
          </a>
          <a href={PLAY_STORE_URL} className="cx-way">
            <AndroidIcon size={26} />
            <b>Move Score for Android</b>
            <span>On Google Play</span>
          </a>
          <a href="#web" className="cx-way">
            <Globe />
            <b>On the web</b>
            <span>Any browser, no download</span>
          </a>
          <div className="cx-way">
            <Screen />
            <b>At the venue</b>
            <span>Live scores on the court screens</span>
          </div>
        </div>
      </section>

      <section className="cx-sec">
        <p className="cx-kicker">In the app</p>
        <h2 className="cx-disp cx-h2">Your nation, point by point.</h2>
        <ul className="cx-feats">
          <li>
            <b>Live scores</b>
            <span>Every point of every rubber, the moment it is played.</span>
          </li>
          <li>
            <b>Order of play</b>
            <span>Each court&apos;s matches and times, kept up to date on the day.</span>
          </li>
          <li>
            <b>Ties and line-ups</b>
            <span>Singles, doubles and the tie score for every nation.</span>
          </li>
          <li>
            <b>Alerts</b>
            <span>Follow a nation or a player: know when they are on court and how it ended.</span>
          </li>
          <li>
            <b>Match stats</b>
            <span>Points won, break points and more, as the match goes on.</span>
          </li>
          <li>
            <b>Venue map</b>
            <span>Find your court at Smash Sporting Club.</span>
          </li>
        </ul>
        <div className="cx-stores cx-stores-end">{stores}</div>
      </section>

      <footer className="cx-foot">
        <SponsorMarquee logos={edition.partners} label="Partners of the Junior Finals" chips={false} />
        <div className="cx-foot-in">
          <span className="cx-brand">
            <Mark size={24} ink="#0b0d18" />
            <span>
              <b className="cx-disp">MOVE SCORE</b>
              <small>
                by <a href="https://mbeg.org">Move Beyond</a>
              </small>
            </span>
          </span>
          <nav aria-label="Move Score pages">
            <a href="/movescore">About</a>
            <a href="/movescore/support">Support</a>
            <a href="/movescore/privacy">Privacy</a>
            <a href="/movescore/terms">Terms</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Globe() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </svg>
  );
}

function Screen() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
