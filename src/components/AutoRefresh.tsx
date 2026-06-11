"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Polls the server for fresh data — fallback realtime channel for public/TV screens. */
export default function AutoRefresh({ seconds = 7 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
