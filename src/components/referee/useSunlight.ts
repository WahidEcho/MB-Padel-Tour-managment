"use client";

import { useEffect, useState } from "react";

const KEY = "ms.sunlight";

/**
 * The referee console's "☀ Sunlight" switch (web): an extra high-contrast light
 * theme on top of the device's light/dark setting (.theme-sunlight in globals.css),
 * remembered on this browser.
 */
export function useSunlight(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      // Read after the first paint: the server render has no browser storage.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOn(localStorage.getItem(KEY) === "1");
    } catch {
      /* storage blocked */
    }
  }, []);
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  };
  return [on, set];
}
