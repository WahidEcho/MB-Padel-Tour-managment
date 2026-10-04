/**
 * Wallet versions of the event pass. Both are generated on the server and opened
 * by link, so they can be switched on after the app is in the stores.
 *
 * Apple needs a Pass Type ID certificate and its key (APPLE_PASS_CERT,
 * APPLE_PASS_KEY, optional APPLE_PASS_KEY_PASSPHRASE and APPLE_WWDR_CERT; PEM,
 * base64 DER or base64 .p12 — see appleSigner.ts; the pass type and team come
 * from the certificate; /api/health/wallet says what is wrong). Google needs an
 * issuer account (GOOGLE_WALLET_ISSUER_ID) and a service account key
 * (GOOGLE_WALLET_SA_EMAIL, GOOGLE_WALLET_SA_KEY). Without them, both say so.
 */
import path from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { appLink } from "../messaging/links";
import { db } from "../supabase";
import { AppleWalletSetupError, appleSigner } from "./appleSigner";

export interface WalletPassData {
  id: string;
  serial: number;
  edition: "spectator" | "staff";
  staffRole: string | null;
  holderName: string | null;
  nationCode: string | null;
  onsite: boolean;
  stamps: number;
  event: { name: string; venue: string | null; city: string | null; startsOn: string | null; endsOn: string | null };
}

export async function walletData(passId: string): Promise<WalletPassData | null> {
  const { data } = await db()
    .from("event_passes")
    .select("id, serial, edition, staff_role, holder_name, nation_code, onsite_unlocked_at, event_groups(name, venue_name, city, starts_on, ends_on)")
    .eq("id", passId)
    .maybeSingle();
  const p = data as unknown as {
    id: string;
    serial: number;
    edition: "spectator" | "staff";
    staff_role: string | null;
    holder_name: string | null;
    nation_code: string | null;
    onsite_unlocked_at: string | null;
    event_groups: { name: string; venue_name: string | null; city: string | null; starts_on: string | null; ends_on: string | null };
  } | null;
  if (!p) return null;
  const { count } = await db().from("pass_stamps").select("day", { count: "exact", head: true }).eq("pass_id", passId);
  return {
    id: p.id,
    serial: p.serial,
    edition: p.edition,
    staffRole: p.staff_role,
    holderName: p.holder_name,
    nationCode: p.nation_code,
    onsite: Boolean(p.onsite_unlocked_at),
    stamps: count ?? 0,
    event: { name: p.event_groups.name, venue: p.event_groups.venue_name, city: p.event_groups.city, startsOn: p.event_groups.starts_on, endsOn: p.event_groups.ends_on },
  };
}

// The pass is the attendee's: never a staff role, whatever an old row says.
const editionLabel = (d: WalletPassData) => (d.onsite ? "ON-SITE" : "SPECTATOR");

/**
 * Whether this server can sign Apple Wallet passes: the certificate and key are
 * set, readable, belong together and chain to Apple (see appleSigner.ts). Being
 * merely set is not enough: unreadable values used to report "ready" here while
 * every download failed.
 */
export function appleWalletConfigured(): boolean {
  return !(appleSigner() instanceof AppleWalletSetupError);
}

/** For /api/health/wallet: what Wallet will see, or what to fix. Never the values. */
export function appleWalletStatus(): { ready: boolean; problem?: string; passTypeIdentifier?: string; teamIdentifier?: string; expiresAt?: string; notes?: string[] } {
  const s = appleSigner();
  if (s instanceof AppleWalletSetupError) return { ready: false, problem: s.message };
  return { ready: true, passTypeIdentifier: s.passTypeIdentifier, teamIdentifier: s.teamIdentifier, expiresAt: s.expiresAt, notes: s.notes };
}

/** Whether this server can make Google Wallet save links (the issuer account is set). */
export function googleWalletConfigured(): boolean {
  const { GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SA_EMAIL, GOOGLE_WALLET_SA_KEY } = process.env;
  return Boolean(GOOGLE_WALLET_ISSUER_ID && GOOGLE_WALLET_SA_EMAIL && GOOGLE_WALLET_SA_KEY);
}

/** The signed .pkpass, or null when the credentials are missing or unusable (logged by appleSigner). */
export async function applePass(d: WalletPassData): Promise<Buffer | null> {
  const signer = appleSigner();
  if (signer instanceof AppleWalletSetupError) return null;
  const { PKPass } = await import("passkit-generator");
  const pass = await PKPass.from(
    {
      model: path.join(process.cwd(), "src/lib/pass/model.pass"),
      certificates: { wwdr: signer.wwdr, signerCert: signer.signerCert, signerKey: signer.signerKey },
    },
    // Wallet only accepts the identifiers of the certificate that signs the pass.
    { serialNumber: d.id, passTypeIdentifier: signer.passTypeIdentifier, teamIdentifier: signer.teamIdentifier },
  );
  pass.primaryFields.push({ key: "event", label: editionLabel(d), value: d.event.name });
  pass.secondaryFields.push({ key: "holder", label: "HOLDER", value: d.holderName ?? "Move Score fan" }, { key: "no", label: "NO.", value: String(d.serial).padStart(6, "0") });
  pass.auxiliaryFields.push({ key: "venue", label: "VENUE", value: [d.event.venue, d.event.city].filter(Boolean).join(", ") || "—" }, { key: "days", label: "DAYS", value: String(d.stamps) });
  // The one public link on the pass comes from PUBLIC_SITE_URL (messaging/links.ts).
  pass.backFields.push({ key: "about", label: "Move Score", value: `Live scores, the draw and your event pass: open the Move Score app. ${appLink()}` });
  pass.setBarcodes({ message: `movescore://pass/${d.id}`, format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1" });
  if (d.event.startsOn) pass.setRelevantDate(new Date(`${d.event.startsOn}T08:00:00Z`));
  return pass.getAsBuffer();
}

export async function googleSaveUrl(d: WalletPassData, origin: string): Promise<string | null> {
  const { GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SA_EMAIL, GOOGLE_WALLET_SA_KEY } = process.env;
  if (!GOOGLE_WALLET_ISSUER_ID || !GOOGLE_WALLET_SA_EMAIL || !GOOGLE_WALLET_SA_KEY) return null;
  const key = await importPKCS8(GOOGLE_WALLET_SA_KEY.replace(/\\n/g, "\n"), "RS256");
  const classId = `${GOOGLE_WALLET_ISSUER_ID}.movescore_event`;
  const object = {
    id: `${GOOGLE_WALLET_ISSUER_ID}.${d.id.replace(/-/g, "")}`,
    classId,
    state: "ACTIVE",
    cardTitle: { defaultValue: { language: "en", value: "Move Score" } },
    header: { defaultValue: { language: "en", value: d.event.name } },
    subheader: { defaultValue: { language: "en", value: editionLabel(d) } },
    hexBackgroundColor: "#01041a",
    logo: { sourceUri: { uri: `${origin}/movescore/pass-logo.png` } },
    textModulesData: [
      { id: "holder", header: "Holder", body: d.holderName ?? "Move Score fan" },
      { id: "no", header: "No.", body: String(d.serial).padStart(6, "0") },
    ],
    barcode: { type: "QR_CODE", value: `movescore://pass/${d.id}` },
  };
  const jwt = await new SignJWT({ origins: [origin], typ: "savetowallet", payload: { genericClasses: [{ id: classId }], genericObjects: [object] } })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(GOOGLE_WALLET_SA_EMAIL)
    .setAudience("google")
    .setIssuedAt()
    .sign(key);
  return `https://pay.google.com/gp/v/save/${jwt}`;
}
