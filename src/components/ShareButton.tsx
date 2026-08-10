"use client";

import { useState } from "react";

/**
 * Share a link the way club organisers actually do it: WhatsApp, or copy.
 * `wa.me` needs no API, no approval and costs nothing — and a tap opens a free
 * 24-hour service window on the WhatsApp Business platform.
 */
export default function ShareButton({
  path,
  text,
  label = "Share",
}: {
  /** Path on this site, e.g. `/f/tuesday/rankings`. */
  path: string;
  /** Message to prefill. The URL is appended. */
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const url = typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
  const wa = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <a
        href={wa}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-secondary text-xs"
        aria-label={`${label} on WhatsApp`}
      >
        WhatsApp
      </a>
      <button onClick={copy} className="btn-secondary text-xs">
        {copied ? "Copied ✓" : "Copy link"}
      </button>
    </div>
  );
}
