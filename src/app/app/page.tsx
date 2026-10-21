import type { Metadata } from "next";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { siteUrl } from "@/lib/messaging/links";
import { appStoreLive, platformOf } from "./stores";
import { AndroidButton, BRAND, IosButton, Shell, display } from "./ui";

/**
 * tour.mbeg.org/app: pick your phone. iPhone → the App Store (once Apple has
 * published it; "coming soon" until then), Android → /app/android (download and
 * install steps). The visitor's own phone is shown first; a desktop gets a QR code.
 */
export const metadata: Metadata = {
  title: { absolute: "Download Move Score · Move Beyond" },
  description: "Get the Move Score app for iPhone and Android: live scores, order of play, draws and alerts for the events you follow.",
  openGraph: { title: "Download Move Score", description: "Live scores, order of play and alerts. By Move Beyond.", images: [BRAND.logo] },
};

export default async function DownloadPage() {
  const platform = platformOf((await headers()).get("user-agent"));
  const [iosLive, qr] = await Promise.all([
    appStoreLive(),
    QRCode.toString(`${siteUrl()}/app`, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#05060f", light: "#ffffff" } }),
  ]);
  const ios = <IosButton key="i" live={iosLive} />;
  const android = <AndroidButton key="a" href="/app/android" kicker="Get it for" label="Android" />;

  return (
    <Shell>
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

          <div className="grid max-w-md gap-3">{platform === "android" ? [android, ios] : [ios, android]}</div>

          <p className="text-xs text-white/50">iPhone: iOS 16.4 or newer. Android: version 8 or newer.</p>
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
    </Shell>
  );
}
