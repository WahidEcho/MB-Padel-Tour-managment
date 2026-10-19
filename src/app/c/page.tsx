import type { Metadata } from "next";
import { ANDROID_APP_URL, IOS_APP_STORE_URL } from "@/lib/site";
import CoachLinkActions from "./CoachLinkActions";

export const metadata: Metadata = { title: "Team coach · Move Score", robots: { index: false, follow: false } };

/**
 * A team coach card's QR link, https://tour.mbeg.org/c#<code> (migration 0037). With Move
 * Score installed the phone opens the app on the coach sign-in (universal link / app link:
 * /c is in the apple-app-site-association and the Android intent filter). This page is what
 * a phone without the app sees: the download links, and the web view on request. The code
 * is in the #fragment, so it reaches no server, CDN or proxy log unless the person taps
 * "Open My team in this browser".
 */
export default function CoachQrPage() {
  return (
    <main className="theme-auto flex flex-1 items-center justify-center bg-background p-6 text-foreground">
      <div className="card w-full max-w-sm space-y-4 p-6 text-center" data-testid="coach-qr">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Move Score</p>
          <h1 className="text-xl font-bold">Team coach</h1>
        </div>
        <p className="text-sm text-muted">This card&apos;s QR code opens your team in the Move Score app: ties, line-ups, live scores and alerts.</p>
        <CoachLinkActions />
        <div className="space-y-2 border-t border-border pt-4 text-sm">
          <p className="font-semibold">No Move Score on this phone?</p>
          <a href={ANDROID_APP_URL} className="btn-secondary w-full justify-center py-2 text-sm" data-testid="get-android">Android: download Move Score</a>
          {IOS_APP_STORE_URL ? (
            <a href={IOS_APP_STORE_URL} className="btn-secondary w-full justify-center py-2 text-sm" data-testid="get-ios">iPhone: Move Score on the App Store</a>
          ) : (
            <p className="text-xs text-muted" data-testid="get-ios">iPhone: ask the tournament desk to install Move Score on this phone.</p>
          )}
          <p className="text-xs text-muted">Then scan the code again, or open Move Score → Account → Staff → Coach sign-in and type the code printed on the card.</p>
        </div>
      </div>
    </main>
  );
}
