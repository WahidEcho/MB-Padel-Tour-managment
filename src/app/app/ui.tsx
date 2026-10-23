import localFont from "next/font/local";
import { ANDROID_APK, TESTFLIGHT_URL } from "./stores";

/**
 * The look shared by the download pages (/app and /app/android). Branded Move
 * Beyond for now: event and sponsor branding go in BRAND (logo, accent, partner
 * logos) without touching the pages.
 */
export const BRAND = {
  name: "Move Beyond",
  site: "https://mbeg.org",
  logo: "/brand/move-beyond-logo-white.png",
  accent: "#FCFC00",
  /** [name, logo url] of sponsors shown under "Presented with"; none yet. */
  partners: [] as [string, string][],
};

export const display = localFont({ src: "../../../public/brand/fonts/Archivo-ExpandedBlack.ttf", display: "swap" });

const APPLE_PATH =
  "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701";

export function AppleIcon({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="currentColor">
      <path d={APPLE_PATH} />
    </svg>
  );
}

export function AndroidIcon({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="currentColor">
      <path d="M3 18.5a9 9 0 0 1 18 0z" />
      <path d="M6.2 6.2 8 9.3M17.8 6.2 16 9.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <circle cx="8.6" cy="14.6" r="1.05" fill="#05060f" />
      <circle cx="15.4" cy="14.6" r="1.05" fill="#05060f" />
    </svg>
  );
}

export function IosButton({ live }: { live: boolean }) {
  if (!live) {
    // Before the App Store approval: early access through Apple's TestFlight app.
    return (
      <div id="iphone" className="grid gap-2">
        <a
          href={TESTFLIGHT_URL}
          className="flex min-h-16 w-full items-center gap-3 rounded-2xl bg-white px-5 py-3 text-left text-black shadow-lg shadow-black/30 transition hover:scale-[1.01] active:scale-[0.99]"
        >
          <AppleIcon />
          <span className="leading-tight">
            <span className="block text-[11px] uppercase tracking-[0.18em] text-black/60">iPhone · early access</span>
            <span className="block text-lg font-bold">Get it with Apple TestFlight</span>
          </span>
        </a>
        <p className="px-1 text-xs leading-relaxed text-white/60">
          Tap the button on your iPhone, install Apple&apos;s free TestFlight app if asked, then tap <b>Accept</b> and <b>Install</b>. Once Move
          Score is on the App Store, this button takes you there.
        </p>
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

/** The yellow Android button: to the Android page (`/app/android`) or, on that page, the APK itself. */
export function AndroidButton({ href, kicker, label, size }: { href: string; kicker: string; label: string; size?: boolean }) {
  return (
    <a
      href={href}
      className="flex min-h-16 w-full items-center gap-3 rounded-2xl px-5 py-3 text-left text-black shadow-lg shadow-black/30 transition hover:scale-[1.01] active:scale-[0.99]"
      style={{ background: BRAND.accent }}
    >
      <span style={{ color: "#05060f" }}>
        <AndroidIcon />
      </span>
      <span className="leading-tight">
        <span className="block text-[11px] uppercase tracking-[0.18em] text-black/60">{kicker}</span>
        <span className="block text-lg font-bold">{label}</span>
      </span>
      {size ? <span className="ml-auto text-right text-[11px] font-semibold text-black/60">APK · {ANDROID_APK.sizeMb} MB</span> : null}
    </a>
  );
}

/** Page frame: background, header with the brand logo, footer. */
export function Shell({ children, back }: { children: React.ReactNode; back?: { href: string; label: string } }) {
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
        <a
          href={back?.href ?? "/movescore/support"}
          className="rounded-full border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/80 hover:bg-white/10"
        >
          {back?.label ?? "Help"}
        </a>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-5xl px-5 pb-16 pt-10 sm:pt-16">
        {children}
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
