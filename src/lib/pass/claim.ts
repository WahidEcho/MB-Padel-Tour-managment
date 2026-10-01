import { createHash, randomInt } from "crypto";

/** Ten characters from an alphabet without look-alikes, shown as XXXXX-XXXXX. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newClaimCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function hashClaimCode(code: string): string {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return createHash("sha256").update(`claim:${clean}:${process.env.AUTH_SECRET ?? ""}`).digest("hex");
}
