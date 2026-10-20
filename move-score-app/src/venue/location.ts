/**
 * The phone's position and compass for the venue map, from expo-location, only
 * while the map asks for them (Centre on me, Directions) and is on screen. The
 * map page gets them through the WebView bridge (@core parseToMap); nothing is
 * sent to the server.
 */
import * as Location from "expo-location";
import type { ToMap } from "@core";

/** Heading updates at most this often (the compass fires many times a second). */
const HEADING_MS = 200;

export async function startVenueLocation(send: (m: ToMap) => void): Promise<() => void> {
  const perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
  if (!perm || perm.status !== "granted") {
    send({ type: "location-off", reason: "denied" });
    return () => {};
  }
  if (!(await Location.hasServicesEnabledAsync().catch(() => true))) {
    send({ type: "location-off", reason: "unavailable" });
    return () => {};
  }
  let heading: number | null = null;
  let lastHeading = 0;
  const pos = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 1 },
    (p) =>
      send({
        type: "location",
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: p.coords.accuracy ?? null,
        heading: heading ?? (p.coords.heading != null && p.coords.heading >= 0 ? p.coords.heading : null),
        at: p.timestamp,
      }),
  ).catch(() => null);
  if (!pos) {
    send({ type: "location-off", reason: "unavailable" });
    return () => {};
  }
  const head = await Location.watchHeadingAsync((h) => {
    const v = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
    if (!(v >= 0)) return;
    heading = v;
    const now = Date.now();
    if (now - lastHeading < HEADING_MS) return;
    lastHeading = now;
    send({ type: "heading", heading: v });
  }).catch(() => null);
  return () => {
    pos.remove();
    head?.remove();
  };
}
