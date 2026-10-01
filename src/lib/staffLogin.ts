import { checkRateLimit } from "./ratelimit";

/**
 * Brake on guessing staff access codes, shared by the web login and the app.
 * Per address, generous because a whole venue can share one mobile-network
 * address; plus a global ceiling no guessing script gets past.
 */
export async function staffLoginAllowed(ip: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const perIp = await checkRateLimit({ key: `staff-login:${ip}`, limit: 20, windowSeconds: 15 * 60 });
  if (!perIp.allowed) return { allowed: false, retryAfterSeconds: perIp.retryAfterSeconds };
  const all = await checkRateLimit({ key: "staff-login:all", limit: 300, windowSeconds: 60 * 60 });
  return { allowed: all.allowed, retryAfterSeconds: all.retryAfterSeconds };
}
