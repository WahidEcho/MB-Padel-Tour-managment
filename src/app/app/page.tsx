import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import QRCode from "qrcode";
import { siteUrl } from "@/lib/messaging/links";
import { ANDROID_APK, appStoreLive, platformOf, type Platform } from "./stores";

/**
 * tour.mbeg.org/app: download Move Score. iPhone → the App Store (once Apple has
 * published it; "coming soon" until then), Android → the APK with install steps.
 * The visitor's own phone is shown first; a desktop gets a QR code to scan.
 *
 * Branded Move Beyond for now. Event and sponsor branding go in BRAND below
 * (logo, accent, partner logos) without touching the rest of the page.
 */
const BRAND = {
  name: "Move Beyond",
  site: "https://mbeg.org",
  logo: "/brand/move-beyond-logo-white.png",
  accent: "#FCFC00",
  /** [name, logo url] of sponsors shown under "Presented with"; none yet. */
  partners: [] as [string, string][],
};

const display = localFont({ src: "../../../public/brand/fonts/Archivo-ExpandedBlack.ttf", display: "swap" });

export const metadata: Metadata = {
  title: { absolute: "Download Move Score · Move Beyond" },
  description: "Get the Move Score app for iPhone and Android: live scores, order of play, draws and alerts for the events you follow.",
  openGraph: { title: "Download Move Score", description: "Live scores, order of play and alerts. By Move Beyond.", images: [BRAND.logo] },
};

const APPLE_PATH =
  "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701";

function AppleIcon({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="currentColor">
      <path d={APPLE_PATH} />
    </svg>
  );
}

function AndroidIcon({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="currentColor">
      <path d="M3 18.5a9 9 0 0 1 18 0z" />
      <path d="M6.2 6.2 8 9.3M17.8 6.2 16 9.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <circle cx="8.6" cy="14.6" r="1.05" fill="#05060f" />
      <circle cx="15.4" cy="14.6" r="1.05" fill="#05060f" />
    </svg>
  );
}

function IosButton({ live }: { live: boolean }) {
  if (!live) {
    return (
      <div
        id="iphone"
        className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-white/15 bg-white/5 px-5 py-3 text-left"
        aria-label="iPhone: coming soon to the App Store"
      >
        <AppleIcon />
        <span className="leading-tight">
          <span className="block text-[11px] uppercase tracking-[0.18em] text-white/60">iPhone · coming soon</span>
          <span className="block text-lg font-bold">App Store</span>
        </span>
      </div>
    );
  }
  return (
    <a
      id="iphone"
      href="/app/ios"
      className="flex min-h-16 w-full items-center gap-3 rounded-2xl bg-white px-5 py-3 text-left text-black shadow-lg shadow-black/30 transition hover:scale-[1.01] active:scale-[0.99]"
    >
      <AppleIcon />
      <span className="leading-tight">
        <span className="block text-[11px] uppercase tracking-[0.18em] text-black/60">Download on the</span>
        <span className="block text-lg font-bold">App Store</span>
      </span>
    </a>
  );
}

function AndroidButton() {
  return (
    <a
      href="/app/android"
      className="flex min-h-16 w-full items-center gap-3 rounded-2xl px-5 py-3 text-left text-black shadow-lg shadow-black/30 transition hover:scale-[1.01] active:scale-[0.99]"
      style={{ background: BRAND.accent }}
    >
      <span style={{ color: "#05060f" }}>
        <AndroidIcon />
      </span>
      <span className="leading-tight">
        <span className="block text-[11px] uppercase tracking-[0.18em] text-black/60">Download for</span>
        <span className="block text-lg font-bold">Android</span>
      </span>
      <span className="ml-auto text-right text-[11px] font-semibold text-black/60">
        APK · {ANDROID_APK.sizeMb} MB
      </span>
    </a>
  );
}

const ANDROID_STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Download",
    body: (
      <>
        Open this page on your Android phone (Chrome is best) and tap <strong>Download for Android</strong>. If Chrome warns that
        the file may be harmful, tap <strong>Download anyway</strong>. Use Wi-Fi if you can: it is about {ANDROID_APK.sizeMb} MB.
      </>
    ),
  },
  {
    title: "Open the file",
    body: (
      <>
        When the download finishes, tap <strong>Open</strong> in the bar at the bottom, or find <strong>Move Score</strong> in your{" "}
        <strong>Downloads</strong> (Files app → Downloads).
      </>
    ),
  },
  {
    title: "Allow this install",
    body: (
      <>
        The first time, Android blocks apps from outside Google Play. Tap <strong>Settings</strong> on the message, turn on{" "}
        <strong>Allow from this source</strong>, then press back. This allows Chrome (or your Files app) only, not every app.
      </>
    ),
  },
  {
    title: "Install",
    body: (
      <>
        Tap <strong>Install</strong>. If Google Play Protect says the app is unrecognised, tap <strong>More details</strong> →{" "}
        <strong>Install anyway</strong>. Move Score is signed by Move Beyond.
      </>
    ),
  },
  {
    title: "Open and allow alerts",
    body: (
      <>
        Open Move Score and tap <strong>Allow</strong> for notifications, so you hear when a match is called, starts and finishes.
      </>
    ),
  },
];

const PHONE_NOTES: [string, React.ReactNode][] = [
  [
    "Didn't see “Allow from this source”?",
    <>
      Go to <strong>Settings → Apps → Special app access → Install unknown apps</strong>, choose <strong>Chrome</strong> (or the
      browser you used) and turn on <strong>Allow from this source</strong>.
    </>,
  ],
  [
    "Samsung",
    <>
      <strong>Settings → Apps → ⋮ (top right) → Special access → Install unknown apps → Chrome → Allow</strong>. If Auto Blocker is
      on, turn it off for the install in <strong>Settings → Security and privacy → Auto Blocker</strong>.
    </>,
  ],
  [
    "Xiaomi, Redmi, POCO",
    <>
      <strong>Settings → Apps → Manage apps → Chrome → Install unknown apps → Allow</strong>. When the security scan finishes, tap{" "}
      <strong>Continue installation</strong>.
    </>,
  ],
  [
    "Oppo, realme, OnePlus, vivo",
    <>
      <strong>Settings → Apps → Special app access → Install unknown apps → Chrome → Allow</strong>. If asked, confirm with your
      lock screen code.
    </>,
  ],
  [
    "Huawei, Honor",
    <>
      <strong>Settings → Security → More settings → Install apps from external sources → Chrome → Allow</strong>.
    </>,
  ],
];

export default async function DownloadPage() {
  const ua = (await headers()).get("user-agent");
  const platform: Platform = platformOf(ua);
  const [iosLive, qr] = await Promise.all([
    appStoreLive(),
    QRCode.toString(`${siteUrl()}/app`, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060f", light: "#ffffff" } }),
  ]);
  const buttons = platform === "android" ? [<AndroidButton key="a" />, <IosButton key="i" live={iosLive} />] : [<IosButton key="i" live={iosLive} />, <AndroidButton key="a" />];

  return (
    <div
      className="relative min-h-screen overflow-hidden text-white"
      style={{
        background:
          "radial-gradient(1200px 600px at 85% -10%, rgba(252,252,0,0.16), transparent 60%), radial-gradient(900px 500px at -10% 30%, rgba(0,174,239,0.14), transparent 60%), #05060f",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 top-24 h-64 w-64 rounded-full opacity-90 blur-[2px] sm:h-80 sm:w-80"
        style={{ background: BRAND.accent, boxShadow: `0 0 120px 30px ${BRAND.accent}55` }}
      />

      <header className="relative z-10 mx-auto flex w-full max-w-5xl items-center justify-between px-5 pt-6">
        <a href={BRAND.site} aria-label={BRAND.name}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={BRAND.logo} alt={BRAND.name} className="h-9 w-auto sm:h-11" />
        </a>
        <a href="/movescore/support" className="rounded-full border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/80 hover:bg-white/10">
          Help
        </a>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-5xl px-5 pb-16 pt-10 sm:pt-16">
        <section className="grid items-center gap-10 lg:grid-cols-[1.25fr_1fr]">
          <div className="space-y-6">
            <p className="text-xs font-bold uppercase tracking-[0.28em]" style={{ color: BRAND.accent }}>
              Move Score app
            </p>
            <h1 className={`${display.className} text-[2.6rem] leading-[0.95] sm:text-6xl`}>
              Every court.
              <br />
              Every point.
            </h1>
            <p className="max-w-xl text-base text-white/75 sm:text-lg">
              Live scores straight from the umpire, the order of play, draws and alerts for the players you follow. Free, no ads.
            </p>

            <div className="grid max-w-md gap-3">{buttons}</div>

            <p className="text-xs text-white/50">
              iPhone: iOS 16.4 or newer. Android: version 8 or newer. Version {ANDROID_APK.version}.
            </p>
          </div>

          <div className="hidden justify-center lg:flex">
            <div className="w-full max-w-xs rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-center backdrop-blur">
              <div className="mx-auto w-52 overflow-hidden rounded-2xl bg-white p-3" dangerouslySetInnerHTML={{ __html: qr }} />
              <p className="mt-4 font-bold">Scan with your phone</p>
              <p className="mt-1 text-sm text-white/60">Opens this page on your phone, with the right download for it.</p>
              <p className="mt-3 text-xs font-semibold tracking-wide text-white/50">tour.mbeg.org/app</p>
            </div>
          </div>
        </section>

        <section id="android" className="mt-20 space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.28em] text-white/50">Android</p>
              <h2 className={`${display.className} mt-2 text-2xl sm:text-3xl`}>Install in five steps</h2>
            </div>
            <p className="max-w-sm text-sm text-white/60">
              Until Move Score is on Google Play, it installs straight from this page. Same app, signed by {BRAND.name}.
            </p>
          </div>

          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {ANDROID_STEPS.map((s, i) => (
              <li key={s.title} className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-black text-black"
                  style={{ background: BRAND.accent }}
                >
                  {i + 1}
                </span>
                <p className="mt-3 font-bold">{s.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-white/70">{s.body}</p>
              </li>
            ))}
          </ol>

          <div className="max-w-md">
            <AndroidButton />
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <p className="font-bold">Turning on “unknown sources” by phone</p>
            <dl className="mt-3 divide-y divide-white/10">
              {PHONE_NOTES.map(([phone, how]) => (
                <div key={phone} className="grid gap-1 py-3 sm:grid-cols-[220px_1fr]">
                  <dt className="text-sm font-semibold text-white">{phone}</dt>
                  <dd className="text-sm leading-relaxed text-white/70">{how}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-white/50">
              After installing you can turn the switch off again; Move Score keeps working. To update, download from this page again and
              install over it: your follows, pass and sign-in stay.
            </p>
          </div>
        </section>

        {BRAND.partners.length ? (
          <section className="mt-16 text-center">
            <p className="text-xs font-bold uppercase tracking-[0.28em] text-white/50">Presented with</p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-8">
              {BRAND.partners.map(([name, logo]) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={name} src={logo} alt={name} className="h-10 w-auto opacity-90" />
              ))}
            </div>
          </section>
        ) : null}
      </main>

      <footer className="relative z-10 border-t border-white/10 px-5 py-6 text-xs text-white/50">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3">
          <p>
            Move Score is made by{" "}
            <a href={BRAND.site} className="text-white/80 hover:underline">
              {BRAND.name}
            </a>
            .
          </p>
          <nav className="flex flex-wrap gap-4" aria-label="Move Score pages">
            <a href="/movescore" className="hover:text-white">About</a>
            <a href="/movescore/support" className="hover:text-white">Support</a>
            <a href="/movescore/privacy" className="hover:text-white">Privacy</a>
            <a href="/movescore/terms" className="hover:text-white">Terms</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
