import type { Metadata } from "next";
import { headers } from "next/headers";
import { PLAY_STORE_URL, TESTFLIGHT_URL, appStoreLive, platformOf } from "./stores";
import { AndroidIcon, AppleIcon, BRAND, display } from "./ui";
import { OrbitPage } from "./Orbit";

/**
 * tour.mbeg.org/app: pick your phone. iPhone → the App Store (once Apple has published it;
 * Apple TestFlight until then), Android → Google Play (the APK and its install steps stay on
 * /app/android). The visitor's own phone is shown first. The look is design C, "Orbit" (Orbit.tsx).
 */
export const metadata: Metadata = {
  title: { absolute: "Download Move Score · Move Beyond" },
  description: "Get the Move Score app for iPhone and Android: live scores, order of play, draws and alerts for the events you follow.",
  openGraph: { title: "Download Move Score", description: "Live scores, order of play and alerts. By Move Beyond.", images: [BRAND.logo] },
};

const BUTTON = { width: "100%", boxSizing: "border-box", justifyContent: "center", color: "#05060f" } as const;

export default async function DownloadPage() {
  const platform = platformOf((await headers()).get("user-agent"));
  const iosLive = await appStoreLive();
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
