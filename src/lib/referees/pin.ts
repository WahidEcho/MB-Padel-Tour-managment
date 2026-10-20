/**
 * Referee PINs (migration 0035), server only (node:crypto). A PIN is four digits,
 * so on its own it is weak: only an HMAC-SHA256 of "<organisation>:<PIN>" keyed with
 * the server's EVENT_CODE_PEPPER is stored (the same pepper as event codes,
 * src/lib/orgs/codes.ts), so a copy of the table cannot be searched for PINs without
 * the pepper; and a PIN is only ever tried together with a court (or master) code,
 * behind per-code and per-address brakes (src/lib/referees/server.ts). PINs are never
 * logged and never written to the audit log.
 */
import { createHmac, randomInt } from "node:crypto";
import { eventCodePepper } from "../orgs/codes";
import { isWeakPin } from "./rules";

/** What is stored for a PIN: 64 hex characters, unique among the organisation's active referees. */
export function hashRefereePin(orgId: string, pin: string, pepper = eventCodePepper()): string {
  return createHmac("sha256", pepper).update(`mb-referee-pin:v1:${orgId}:${pin}`).digest("hex");
}

/** A fresh PIN that is not weak and not in `taken` (hashes of the organisation's active PINs). */
export function generateRefereePin(orgId: string, taken: Set<string>, pepper = eventCodePepper()): string | null {
  for (let i = 0; i < 400; i++) {
    const pin = String(randomInt(10_000)).padStart(4, "0");
    if (isWeakPin(pin)) continue;
    if (!taken.has(hashRefereePin(orgId, pin, pepper))) return pin;
  }
  return null;
}

/**
 * The stored form of a device a referee signed in on (referee_sessions.device_hash,
 * migration 0041): "app:<installation id>" (from the verified install token) or
 * "web:<random browser id>" (the HttpOnly device cookie). Peppered, so the table never
 * holds an id a request could replay.
 */
export function hashRefereeDevice(deviceKey: string, pepper = eventCodePepper()): string {
  return createHmac("sha256", pepper).update(`mb-referee-device:v1:${deviceKey}`).digest("hex");
}
