/**
 * Constant-time string comparison that never throws.
 *
 * `timingSafeEqual` throws when its two buffers differ in length. Comparing
 * `a.length` (UTF-16 units) first is not enough: "é" and "e" are both one unit
 * but two and one bytes, so a signature with a multi-byte character of the right
 * string length used to throw, and the request failed with a 500 instead of a
 * plain "not signed in". The byte lengths are compared instead. Server-only.
 */
import { timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.byteLength !== y.byteLength) return false;
  return timingSafeEqual(x, y);
}
