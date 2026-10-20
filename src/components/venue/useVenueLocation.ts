"use client";

/**
 * The phone's position and compass heading for the map, only after the person
 * asks for them (Centre on me, Directions). Inside the Move Score app the app
 * owns location (expo-location) and feeds it through the WebView bridge
 * (src/lib/venue/bridge.ts); in a browser it is the Geolocation API and the
 * device orientation events.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { parseToMap, type FromMap } from "@/lib/venue/bridge";

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
  heading: number | null;
  at: number;
}

export type LocationStatus = "off" | "asking" | "on" | "denied" | "unavailable";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (data: string) => void };
  }
}

export function inApp(): boolean {
  return typeof window !== "undefined" && Boolean(window.ReactNativeWebView);
}

export function postToApp(msg: FromMap) {
  window.ReactNativeWebView?.postMessage(JSON.stringify(msg));
}

export function useVenueLocation(onBridge?: (m: ReturnType<typeof parseToMap>) => void, onFix?: (f: Fix) => void) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [status, setStatus] = useState<LocationStatus>("off");
  const watch = useRef<number | null>(null);
  const bridgeRef = useRef(onBridge);
  const fixRef = useRef(onFix);
  useEffect(() => {
    bridgeRef.current = onBridge;
    fixRef.current = onFix;
  }, [onBridge, onFix]);

  // Messages from the app: positions, the compass, the theme, a court to focus.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = parseToMap(e.data);
      if (!m) return;
      if (m.type === "location") {
        const f = { lat: m.lat, lng: m.lng, accuracy: m.accuracy, heading: m.heading, at: m.at };
        setFix(f);
        fixRef.current?.(f);
        if (m.heading !== null) setHeading(m.heading);
        setStatus("on");
      } else if (m.type === "heading") setHeading(m.heading);
      else if (m.type === "location-off") setStatus(m.reason === "denied" ? "denied" : m.reason === "unavailable" ? "unavailable" : "off");
      bridgeRef.current?.(m);
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("message", onMessage as EventListener);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("message", onMessage as EventListener);
    };
  }, []);

  const onOrientation = useCallback((e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
    if (typeof e.webkitCompassHeading === "number") setHeading(e.webkitCompassHeading);
    else if (e.absolute && typeof e.alpha === "number") setHeading((360 - e.alpha) % 360);
  }, []);

  const start = useCallback(async () => {
    if (inApp()) {
      setStatus((s) => (s === "on" ? s : "asking"));
      postToApp({ type: "want-location", on: true });
      return;
    }
    if (!("geolocation" in navigator)) {
      setStatus("unavailable");
      return;
    }
    if (watch.current !== null) return;
    setStatus("asking");
    // iOS Safari asks for the compass separately, from a tap.
    const D = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
    try {
      if (D?.requestPermission) await D.requestPermission();
    } catch {
      /* the map works without the compass */
    }
    window.addEventListener("deviceorientationabsolute", onOrientation as EventListener);
    window.addEventListener("deviceorientation", onOrientation as EventListener);
    watch.current = navigator.geolocation.watchPosition(
      (p) => {
        const f = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null, heading: p.coords.heading ?? null, at: p.timestamp };
        setFix(f);
        fixRef.current?.(f);
        setStatus("on");
      },
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
  }, [onOrientation]);

  const stop = useCallback(() => {
    if (inApp()) postToApp({ type: "want-location", on: false });
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    window.removeEventListener("deviceorientationabsolute", onOrientation as EventListener);
    window.removeEventListener("deviceorientation", onOrientation as EventListener);
    setStatus("off");
  }, [onOrientation]);

  useEffect(() => () => {
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
  }, []);

  return { fix, heading: heading ?? fix?.heading ?? null, status, start, stop };
}
