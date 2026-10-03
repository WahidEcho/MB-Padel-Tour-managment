"use client";

import { useEffect } from "react";
import { finishFromFragment } from "../actions";

export function OpenApp({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="btn-primary inline-flex items-center justify-center rounded-xl px-5 py-3 text-base font-bold">
      {label}
    </a>
  );
}

/**
 * A confirmation link that went through Supabase's /verify carries the session in
 * the URL fragment (never sent to a server). If it is there, the server finishes a
 * player's registration with it (sets the password they chose); then the fragment
 * is wiped from the address bar.
 */
export function FragmentFinish() {
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = hash.get("access_token");
    if (!token) return;
    history.replaceState(null, "", window.location.pathname);
    void finishFromFragment(token).catch(() => undefined);
  }, []);
  return null;
}
