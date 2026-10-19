import type { Metadata } from "next";
import { ANDROID_APP_URL, IOS_APP_STORE_URL } from "@/lib/site";
import OpenInApp from "./OpenInApp";

export const metadata: Metadata = { title: "Court referee · Move Score", robots: { index: false, follow: false } };

/**
 * The court QR's link, https://tour.mbeg.org/r#<code> (migration 0034). With Move
 * Score installed the phone opens the app (universal link / app link: /r is in the
 * apple-app-site-association and the Android intent filter), which switches the
 * referee to that court. This page is only what a phone without the app sees: it
 * never signs the browser in. The code is in the #fragment, so it reaches no
 * server, CDN or proxy log; "Open in Move Score" hands it to the app.
 */
export default function CourtQrPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card w-full max-w-sm space-y-4 p-6 text-center" data-testid="court-qr">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Move Score</p>
          <h1 className="text-xl font-bold">Court referee</h1>
        </div>
        <p className="text-sm text-muted">This court&apos;s QR code opens the referee console in the Move Score app.</p>
        <OpenInApp />
        <div className="space-y-2 border-t border-border pt-4 text-sm">
          <p className="font-semibold">No Move Score on this phone?</p>
          <a href={ANDROID_APP_URL} className="btn-secondary w-full justify-center py-2 text-sm" data-testid="get-android">Android: download Move Score</a>
          {IOS_APP_STORE_URL ? (
            <a href={IOS_APP_STORE_URL} className="btn-secondary w-full justify-center py-2 text-sm" data-testid="get-ios">iPhone: Move Score on the App Store</a>
          ) : (
            <p className="text-xs text-muted" data-testid="get-ios">iPhone: ask the tournament desk to install Move Score on this phone.</p>
          )}
          <p className="text-xs text-muted">Then scan this code again, or open Move Score → Referee and type the code printed under the QR.</p>
        </div>
      </div>
    </main>
  );
}
