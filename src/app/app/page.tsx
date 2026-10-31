import type { Metadata } from "next";
import { headers } from "next/headers";
import { PLAY_STORE_URL, TESTFLIGHT_URL, appStoreLive, platformOf } from "./stores";
import { AndroidIcon, AppleIcon, BRAND, display } from "./ui";
import { OrbitPage } from "./Orbit";
import { cairoEdition } from "./cairo";
import { CairoEditionPage } from "./CairoEdition";

/**
 * tour.mbeg.org/app: pick your phone. iPhone → the App Store (once Apple has published it;
 * Apple TestFlight until then), Android → Google Play (the APK and its install steps stay on
 * /app/android). The visitor's own phone is shown first. The look is design C, "Orbit" (Orbit.tsx),
 * except while the Cairo Junior Finals are on: then the Cairo edition (cairo.ts, CairoEdition.tsx).
 */
const ORBIT_METADATA: Metadata = {
  title: { absolute: "Download Move Score · Move Beyond" },
  description: "Get the Move Score app for iPhone and Android: live scores, order of play, draws and alerts for the events you follow.",
  openGraph: { title: "Download Move Score", description: "Live scores, order of play and alerts. By Move Beyond.", images: [BRAND.logo] },
};

const CAIRO_METADATA: Metadata = {
  title: { absolute: "Move Score · Live scores of the Davis Cup and Billie Jean King Cup Junior Finals 2026" },
  description:
    "Follow the Davis Cup Junior Finals and the Billie Jean King Cup Junior Finals 2026 in Cairo point by point: live scores, order of play, line-ups and alerts. On iPhone, Android and the web.",
  openGraph: {
    title: "Every point of the Junior Finals, live",
    description: "Davis Cup and Billie Jean King Cup Junior Finals 2026, Cairo. Live scores on Move Score: iPhone, Android and the web.",
    images: ["/sponsors/cairo-2026/dark/davis-cup-event.png"],
  },
};

export async function generateMetadata(): Promise<Metadata> {
  return (await cairoEdition()) ? CAIRO_METADATA : ORBIT_METADATA;
}

const BUTTON = { width: "100%", boxSizing: "border-box", justifyContent: "center", color: "#05060f" } as const;

export default async function DownloadPage() {
  const platform = platformOf((await headers()).get("user-agent"));
  const iosLive = await appStoreLive();
  const cairo = await cairoEdition();
  if (cairo) return <CairoEditionPage edition={cairo} iosLive={iosLive} platform={platform} displayFont={display.style.fontFamily} />;
  const ios = (
    <a key="i" id="iphone" className="ms-btn" href={iosLive ? "/app/ios" : TESTFLIGHT_URL} style={{ ...BUTTON, background: "#ffffff" }}>
      <AppleIcon size={22} />
      {iosLive ? "Download on the App Store" : "iPhone: get it with TestFlight"}
    </a>
  );
  const android = (
    <a key="a" id="android" className="ms-btn" href={PLAY_STORE_URL} style={{ ...BUTTON, background: BRAND.accent }}>
      <AndroidIcon size={22} />
      Get it on Google Play
    </a>
  );
  return <OrbitPage buttons={platform === "android" ? [android, ios] : [ios, android]} displayFont={display.style.fontFamily} />;
}
