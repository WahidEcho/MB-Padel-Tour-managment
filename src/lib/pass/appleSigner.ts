/**
 * Reads the Apple Wallet signing credentials from the environment, whatever
 * shape they were pasted in, and checks them before a pass is signed.
 *
 * passkit-generator (node-forge) only takes clean PEM text. Values copied into a
 * hosting dashboard rarely are: Apple hands out DER `.cer` files and Keychain
 * exports `.p12` bundles, so they arrive base64-encoded, with `\n` escapes, on
 * one line, or wrapped in quotes. Each of these used to fail at signing time with
 * "Invalid PEM formatted message." (a 500, so Safari never showed the Add Pass
 * sheet). Accepted for each variable:
 *
 *  - PEM, with real newlines, `\n` escapes, or spaces in place of newlines;
 *  - the same PEM base64-encoded (`base64 -i cert.pem`);
 *  - a DER certificate or key base64-encoded (`base64 -i pass.cer`);
 *  - a PKCS#12 bundle base64-encoded (`base64 -i Certificates.p12`), in
 *    APPLE_PASS_CERT and/or APPLE_PASS_KEY; its password is APPLE_PASS_KEY_PASSPHRASE.
 *
 * The pass type identifier and team identifier are read from the certificate
 * itself (its UID and OU): Wallet refuses a pass whose pass.json disagrees with
 * the certificate that signed it, so the certificate wins over APPLE_PASS_TYPE_ID
 * and APPLE_TEAM_ID. Apple's WWDR G4 intermediate is bundled, so APPLE_WWDR_CERT
 * may be left out (or be the wrong generation) as long as G4 issued the pass
 * certificate.
 *
 * Error messages name the variable and what is wrong with it, never its value.
 */
import { createHash, createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import forge from "node-forge";

export interface AppleSigner {
  wwdr: string;
  signerCert: string;
  /** Unencrypted PKCS#1 PEM: no passphrase is needed after this. */
  signerKey: string;
  passTypeIdentifier: string;
  teamIdentifier: string;
  expiresAt: string;
  /** Things that are worth fixing in the environment but did not stop signing. */
  notes: string[];
}

export class AppleWalletSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleWalletSetupError";
  }
}

/** Apple Worldwide Developer Relations Certification Authority, G4 (public; valid until 2030-12-10). */
export const APPLE_WWDR_G4 = `-----BEGIN CERTIFICATE-----
MIIEVTCCAz2gAwIBAgIUE9x3lVJx5T3GMujM/+Uh88zFztIwDQYJKoZIhvcNAQEL
BQAwYjELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsT
HUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBS
b290IENBMB4XDTIwMTIxNjE5MzYwNFoXDTMwMTIxMDAwMDAwMFowdTFEMEIGA1UE
Aww7QXBwbGUgV29ybGR3aWRlIERldmVsb3BlciBSZWxhdGlvbnMgQ2VydGlmaWNh
dGlvbiBBdXRob3JpdHkxCzAJBgNVBAsMAkc0MRMwEQYDVQQKDApBcHBsZSBJbmMu
MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANAf
eKp6JzKwRl/nF3bYoJ0OKY6tPTKlxGs3yeRBkWq3eXFdDDQEYHX3rkOPR8SGHgjo
v9Y5Ui8eZ/xx8YJtPH4GUnadLLzVQ+mxtLxAOnhRXVGhJeG+bJGdayFZGEHVD41t
QSo5SiHgkJ9OE0/QjJoyuNdqkh4laqQyziIZhQVg3AJK8lrrd3kCfcCXVGySjnYB
5kaP5eYq+6KwrRitbTOFOCOL6oqW7Z+uZk+jDEAnbZXQYojZQykn/e2kv1MukBVl
PNkuYmQzHWxq3Y4hqqRfFcYw7V/mjDaSlLfcOQIA+2SM1AyB8j/VNJeHdSbCb64D
YyEMe9QbsWLFApy9/a8CAwEAAaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEAMB8G
A1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMEQGCCsGAQUFBwEBBDgwNjA0
BggrBgEFBQcwAYYoaHR0cDovL29jc3AuYXBwbGUuY29tL29jc3AwMy1hcHBsZXJv
b3RjYTAuBgNVHR8EJzAlMCOgIaAfhh1odHRwOi8vY3JsLmFwcGxlLmNvbS9yb290
LmNybDAdBgNVHQ4EFgQUW9n6HeeaGgujmXYiUIY+kchbd6gwDgYDVR0PAQH/BAQD
AgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBCwUAA4IBAQA/Vj2e5bbD
eeZFIGi9v3OLLBKeAuOugCKMBB7DUshwgKj7zqew1UJEggOCTwb8O0kU+9h0UoWv
p50h5wESA5/NQFjQAde/MoMrU1goPO6cn1R2PWQnxn6NHThNLa6B5rmluJyJlPef
x4elUWY0GzlxOSTjh2fvpbFoe4zuPfeutnvi0v/fYcZqdUmVIkSoBPyUuAsuORFJ
EtHlgepZAE9bPFo22noicwkJac3AfOriJP6YRLj477JxPxpd1F1+M02cHSS+APCQ
A1iZQT0xWmJArzmoUUOSqwSonMJNsUvSq3xKX+udO7xPiEAGE/+QF4oIRynoYpgp
pU8RBWk6z/Kf
-----END CERTIFICATE-----
`;

/* ---------------- decoding one variable ---------------- */

interface PemBlock {
  label: string;
  pem: string;
}

/** What a variable decodes to: PEM blocks, or raw DER bytes. */
type Decoded = { kind: "pem"; blocks: PemBlock[] } | { kind: "der"; der: Buffer };

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;

/** Rebuilds one PEM block with proper line breaks, whatever whitespace it arrived with. */
function cleanBlock(label: string, inner: string): PemBlock {
  // Legacy encrypted keys carry two headers before the base64 body.
  const headers: string[] = [];
  let body = inner;
  const proc = /Proc-Type:\s*(\S+)/.exec(body);
  const dek = /DEK-Info:\s*(\S+)/.exec(body);
  if (proc && dek) {
    headers.push(`Proc-Type: ${proc[1]}`, `DEK-Info: ${dek[1]}`);
    body = body.slice(dek.index + dek[0].length);
  }
  const b64 = body.replace(/[^A-Za-z0-9+/=]/g, "");
  const lines = b64.match(/.{1,64}/g) ?? [];
  const head = headers.length ? `${headers.join("\n")}\n\n` : "";
  return { label, pem: `-----BEGIN ${label}-----\n${head}${lines.join("\n")}\n-----END ${label}-----\n` };
}

export function decodeCredential(raw: string): Decoded | null {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
  v = v.replace(/\\r/g, "").replace(/\\n/g, "\n");
  if (v.includes("-----BEGIN")) {
    const blocks = [...v.matchAll(PEM_BLOCK)].map((m) => cleanBlock(m[1], m[2]));
    return blocks.length ? { kind: "pem", blocks } : null;
  }
  const compact = v.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length < 32) return null;
  const text = bytes.toString("latin1");
  if (text.includes("-----BEGIN")) return decodeCredential(text);
  // DER always starts with a SEQUENCE.
  return bytes[0] === 0x30 ? { kind: "der", der: bytes } : null;
}

/* ---------------- certificates and keys ---------------- */

function certsOf(d: Decoded | null): X509Certificate[] {
  if (!d) return [];
  if (d.kind === "pem") {
    return d.blocks.filter((b) => b.label.includes("CERTIFICATE")).flatMap((b) => {
      try {
        return [new X509Certificate(b.pem)];
      } catch {
        return [];
      }
    });
  }
  try {
    return [new X509Certificate(d.der)];
  } catch {
    return [];
  }
}

function keyOf(d: Decoded | null, passphrase: string | undefined): KeyObject | null {
  if (!d) return null;
  const tries: Parameters<typeof createPrivateKey>[0][] = [];
  if (d.kind === "pem") {
    for (const b of d.blocks.filter((x) => x.label.includes("PRIVATE KEY"))) tries.push({ key: b.pem, format: "pem", passphrase });
  } else {
    tries.push({ key: d.der, format: "der", type: "pkcs8", passphrase }, { key: d.der, format: "der", type: "pkcs1" });
  }
  for (const t of tries) {
    try {
      return createPrivateKey(t);
    } catch {
      /* next shape */
    }
  }
  return null;
}

/** A Keychain / openssl .p12 bundle: the pass certificate and its key. */
function fromP12(d: Decoded | null, passphrase: string | undefined): { certs: X509Certificate[]; key: KeyObject | null } | null {
  if (!d || d.kind !== "der") return null;
  try {
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(d.der.toString("binary")), false, passphrase ?? "");
    const bags = (oid: string) => p12.getBags({ bagType: oid })[oid] ?? [];
    const certs = bags(forge.pki.oids.certBag).flatMap((b) => (b.cert ? [new X509Certificate(forge.pki.certificateToPem(b.cert))] : []));
    const k = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)].find((b) => b.key)?.key;
    return { certs, key: k ? createPrivateKey(forge.pki.privateKeyToPem(k)) : null };
  } catch {
    return null; // wrong password, or not a p12
  }
}

/** One field of an X.509 subject ("UID", "OU", ...). */
export function subjectField(cert: X509Certificate, field: string): string | null {
  for (const line of cert.subject.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && line.slice(0, i) === field) return line.slice(i + 1);
  }
  return null;
}

const isPassCert = (c: X509Certificate) => (subjectField(c, "UID") ?? "").startsWith("pass.");

/* ---------------- the whole set ---------------- */

type Env = Record<string, string | undefined>;

function build(env: Env, now: Date): AppleSigner {
  const passphrase = env.APPLE_PASS_KEY_PASSPHRASE || undefined;
  const certIn = decodeCredential(env.APPLE_PASS_CERT ?? "");
  const keyIn = decodeCredential(env.APPLE_PASS_KEY ?? "");
  const p12 = fromP12(certIn, passphrase) ?? fromP12(keyIn, passphrase);

  const candidates = [...certsOf(certIn), ...certsOf(keyIn), ...(p12?.certs ?? [])];
  const signer = candidates.find(isPassCert);
  if (!signer) {
    if (!certIn) throw new AppleWalletSetupError("APPLE_PASS_CERT is not a certificate (expected PEM, or base64 of the .cer / .pem / .p12 file)");
    if (certIn.kind === "der" && !candidates.length) throw new AppleWalletSetupError("APPLE_PASS_CERT could not be read: a .p12 needs its password in APPLE_PASS_KEY_PASSPHRASE");
    throw new AppleWalletSetupError("APPLE_PASS_CERT holds no Pass Type ID certificate (its subject has no pass.* UID)");
  }

  const key = keyOf(keyIn, passphrase) ?? keyOf(certIn, passphrase) ?? p12?.key ?? null;
  if (!key) {
    if (!keyIn) throw new AppleWalletSetupError("APPLE_PASS_KEY is not a private key (expected PEM, or base64 of the .key / .pem / .p12 file)");
    throw new AppleWalletSetupError("APPLE_PASS_KEY could not be opened: check APPLE_PASS_KEY_PASSPHRASE");
  }
  if (key.asymmetricKeyType !== "rsa") throw new AppleWalletSetupError("APPLE_PASS_KEY is not an RSA key");
  if (!signer.checkPrivateKey(key)) throw new AppleWalletSetupError("APPLE_PASS_KEY does not belong to the certificate in APPLE_PASS_CERT");

  if (new Date(signer.validTo).getTime() <= now.getTime()) throw new AppleWalletSetupError(`The pass certificate expired on ${new Date(signer.validTo).toISOString().slice(0, 10)}`);
  if (new Date(signer.validFrom).getTime() > now.getTime()) throw new AppleWalletSetupError("The pass certificate is not valid yet");

  const notes: string[] = [];
  const issuers = [...certsOf(decodeCredential(env.APPLE_WWDR_CERT ?? "")), ...candidates.filter((c) => !isPassCert(c))];
  let wwdr = issuers.find((c) => signer.checkIssued(c) && signer.verify(c.publicKey));
  if (!wwdr) {
    const g4 = new X509Certificate(APPLE_WWDR_G4);
    if (!(signer.checkIssued(g4) && signer.verify(g4.publicKey))) {
      throw new AppleWalletSetupError("APPLE_WWDR_CERT is not the Apple WWDR certificate that issued the pass certificate");
    }
    wwdr = g4;
    if (env.APPLE_WWDR_CERT) notes.push("APPLE_WWDR_CERT is not the issuer of the pass certificate; using the bundled Apple WWDR G4");
  }

  const passTypeIdentifier = subjectField(signer, "UID")!;
  const teamIdentifier = subjectField(signer, "OU") ?? env.APPLE_TEAM_ID ?? "";
  if (!/^[A-Z0-9]{10}$/.test(teamIdentifier)) throw new AppleWalletSetupError("The pass certificate has no team identifier (OU)");
  if (env.APPLE_PASS_TYPE_ID && env.APPLE_PASS_TYPE_ID !== passTypeIdentifier) notes.push(`APPLE_PASS_TYPE_ID (${env.APPLE_PASS_TYPE_ID}) differs from the certificate's ${passTypeIdentifier}; using the certificate's`);
  if (env.APPLE_TEAM_ID && env.APPLE_TEAM_ID !== teamIdentifier) notes.push(`APPLE_TEAM_ID (${env.APPLE_TEAM_ID}) differs from the certificate's ${teamIdentifier}; using the certificate's`);

  return {
    wwdr: wwdr.toString(),
    signerCert: signer.toString(),
    signerKey: key.export({ type: "pkcs1", format: "pem" }).toString(),
    passTypeIdentifier,
    teamIdentifier,
    expiresAt: new Date(signer.validTo).toISOString(),
    notes,
  };
}

const VARS = ["APPLE_PASS_CERT", "APPLE_PASS_KEY", "APPLE_PASS_KEY_PASSPHRASE", "APPLE_WWDR_CERT", "APPLE_PASS_TYPE_ID", "APPLE_TEAM_ID"] as const;
let cached: { fingerprint: string; day: string; result: AppleSigner | AppleWalletSetupError } | null = null;

/** Whether the Apple variables are filled in at all (they may still be wrong). */
export function appleWalletVarsSet(env: Env = process.env): boolean {
  return Boolean(env.APPLE_PASS_CERT && env.APPLE_PASS_KEY);
}

/**
 * The checked signing set, or the reason there is none. Parsed once per set of
 * values (and re-checked daily for expiry), so callers may ask on every request.
 */
export function appleSigner(env: Env = process.env, now = new Date()): AppleSigner | AppleWalletSetupError {
  if (!appleWalletVarsSet(env)) return new AppleWalletSetupError("APPLE_PASS_CERT and APPLE_PASS_KEY are not set");
  const fingerprint = createHash("sha256").update(VARS.map((k) => env[k] ?? "").join("\u0000")).digest("hex");
  const day = now.toISOString().slice(0, 10);
  if (cached && cached.fingerprint === fingerprint && cached.day === day) return cached.result;
  let result: AppleSigner | AppleWalletSetupError;
  try {
    result = build(env, now);
    for (const n of result.notes) console.warn(`[apple-wallet] ${n}`);
  } catch (e) {
    result = e instanceof AppleWalletSetupError ? e : new AppleWalletSetupError(`The Apple Wallet credentials could not be read (${e instanceof Error ? e.name : "error"})`);
    console.error(`[apple-wallet] ${result.message}`);
  }
  cached = { fingerprint, day, result };
  return result;
}
