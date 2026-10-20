"use client";

import { useSyncExternalStore } from "react";
import { coachSignInAction } from "../coach/actions";

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

/**
 * "Open in Move Score" (the app's own scheme with the code from this page's #fragment),
 * and "Open My team in this browser": the code is posted to the coach sign-in only when
 * the person taps it (it never travels in a URL the server sees).
 */
export default function CoachLinkActions() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  const code = decodeURIComponent(hash.replace(/^#/, "")).slice(0, 40);
  if (!code) return <p className="text-sm text-muted">Scan the QR code on your team&apos;s coach card.</p>;
  return (
    <div className="space-y-2">
      <a href={`movescore://c#${encodeURIComponent(code)}`} className="btn-primary w-full justify-center py-3 text-base" data-testid="open-in-app">
        Open in Move Score
      </a>
      <form action={coachSignInAction}>
        <input type="hidden" name="code" value={code} />
        <button className="btn-secondary w-full justify-center py-2 text-sm" data-testid="open-in-browser">Open My team in this browser</button>
      </form>
    </div>
  );
}
