"use client";

import { useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

/** "Open in Move Score": the app's own scheme with the code from this page's #fragment. */
export default function OpenInApp() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  const code = hash.replace(/^#/, "").slice(0, 40);
  if (!code) return <p className="text-sm text-muted">Scan the QR code on the court&apos;s referee table.</p>;
  return (
    <a href={`movescore://r#${code}`} className="btn-primary w-full justify-center py-3 text-base" data-testid="open-in-app">
      Open in Move Score
    </a>
  );
}
