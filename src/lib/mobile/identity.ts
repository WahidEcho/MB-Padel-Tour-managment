/**
 * Who is calling a personal app route: a signed-in user, or a guest phone.
 *
 * Guests are identified by an installation token the server signed when the
 * phone registered (POST /api/mobile/v1/devices). Users send their Supabase
 * session as a bearer token, verified here against the project's public signing
 * keys, so no Supabase key ever ships inside the app.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type Owner = { kind: "user"; id: string } | { kind: "install"; id: string };

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET must be set");
  return s;
}

const sign = (installationId: string, nonce: string) =>
  createHmac("sha256", secret()).update(`install:${installationId}:${nonce}`).digest("base64url");

/**
 * `<installationId>.<nonce>.<signature>`. The nonce is chosen here, at random, so
 * knowing a phone's installation id is not enough to make its token; the devices
 * route only mints one for an id nobody has registered yet. Verified without a
 * database read.
 */
export function mintInstallToken(installationId: string): string {
  const nonce = randomBytes(16).toString("base64url");
  return `${installationId}.${nonce}.${sign(installationId, nonce)}`;
}

/** The installation id a token was minted for, or null (forged, malformed, or the old two-part format). */
export function verifyInstallToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, nonce, sig] = parts as [string, string, string];
  if (!id || nonce.length < 16) return null;
  const expected = sign(id, nonce);
  if (sig.length !== expected.length) return null;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
}

// A web console's device id is a bare browser UUID (getDeviceId, src/lib/offline/db.ts);
// a phone's is its installation id ("ios-<uuid>"), which no other caller may see.
const BROWSER_DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stable stand-in for a scoring device id: tells devices apart without revealing them. */
export function deviceHandle(deviceId: string): string {
  return `d-${createHmac("sha256", secret()).update(`device:${deviceId}`).digest("base64url").slice(0, 16)}`;
}

/**
 * A scoring-lease device id as one viewer may see it. A phone sees its own id
 * (it compares against it to know it holds control); staff see web consoles'
 * browser ids, which the web console compares against; everyone else, and every
 * other phone's id, gets a handle.
 */
export function shownDeviceId(deviceId: string, viewer: { installationId: string | null; staff: boolean }): string {
  if (viewer.installationId && deviceId === viewer.installationId) return deviceId;
  if (viewer.staff && BROWSER_DEVICE_ID.test(deviceId)) return deviceId;
  return deviceHandle(deviceId);
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function keys() {
  if (!jwks) {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error("SUPABASE_URL must be set");
    jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

/** The Supabase user id of a valid access token, or null. */
export async function verifyUserToken(token: string | null | undefined): Promise<string | null> {
  if (!token || token.split(".").length !== 3) return null;
  try {
    const { payload } = await jwtVerify(token, keys(), {
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** The caller of a personal route. A valid user session wins over the install token. */
export async function ownerOf(request: Request): Promise<{ owner: Owner | null; installationId: string | null }> {
  const installationId = verifyInstallToken(request.headers.get("x-install-token"));
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const userId = await verifyUserToken(bearer);
  if (userId) return { owner: { kind: "user", id: userId }, installationId };
  if (installationId) return { owner: { kind: "install", id: installationId }, installationId };
  return { owner: null, installationId: null };
}
