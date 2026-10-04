import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AppleWalletSetupError, appleSigner, decodeCredential, type AppleSigner } from "./appleSigner";

/*
 * A throwaway certificate authority and Pass Type ID certificate, made fresh for
 * each run (no keys in the repo). The real Apple chain can't sign in a test; the
 * shapes the values arrive in are what matters here.
 */

interface ForgeCert {
  publicKey: unknown;
  serialNumber: string;
  validity: { notBefore: Date; notAfter: Date };
  setSubject(a: object[]): void;
  setIssuer(a: object[]): void;
  setExtensions(e: object[]): void;
  sign(key: unknown, md: unknown): void;
}
interface ForgeForTests {
  pki: {
    createCertificate(): ForgeCert;
    publicKeyFromPem(pem: string): unknown;
    privateKeyFromPem(pem: string): unknown;
    certificateToPem(c: ForgeCert): string;
    certificateFromPem(pem: string): ForgeCert;
  };
  md: { sha256: { create(): unknown } };
  pkcs12: { toPkcs12Asn1(key: unknown, certs: unknown[], password: string, opts: object): unknown };
  asn1: { toDer(a: unknown): { getBytes(): string } };
}
const forge = createRequire(import.meta.url)("node-forge") as ForgeForTests;

const UID = "0.9.2342.19200300.100.1.1";
const day = 24 * 3600 * 1000;

function makeCert(opts: { subject: object[]; issuer: object[]; publicPem: string; signerPkcs1: string; ca: boolean; from: Date; to: Date }): string {
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.publicKeyFromPem(opts.publicPem);
  c.serialNumber = "0a";
  c.validity.notBefore = opts.from;
  c.validity.notAfter = opts.to;
  c.setSubject(opts.subject);
  c.setIssuer(opts.issuer);
  c.setExtensions(opts.ca ? [{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true, cRLSign: true }] : [{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true }]);
  c.sign(forge.pki.privateKeyFromPem(opts.signerPkcs1), forge.md.sha256.create());
  return forge.pki.certificateToPem(c);
}

function rsa() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(), pkcs1: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const derOf = (pem: string) => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");

let wwdrPem: string;
let passPem: string;
let key: ReturnType<typeof rsa>;
let other: ReturnType<typeof rsa>;
let p12Legacy: Buffer;
let p12Modern: Buffer;

beforeAll(() => {
  const ca = rsa();
  key = rsa();
  other = rsa();
  const caName = [{ name: "commonName", value: "Test Worldwide Developer Relations" }, { name: "organizationalUnitName", value: "TEST" }];
  const now = Date.now();
  wwdrPem = makeCert({ subject: caName, issuer: caName, publicPem: ca.publicPem, signerPkcs1: ca.pkcs1, ca: true, from: new Date(now - day), to: new Date(now + 3650 * day) });
  passPem = makeCert({
    subject: [{ type: UID, value: "pass.test.movescore" }, { name: "commonName", value: "Pass Type ID: pass.test.movescore" }, { name: "organizationalUnitName", value: "TESTTEAM01" }],
    issuer: caName,
    publicPem: key.publicPem,
    signerPkcs1: ca.pkcs1,
    ca: false,
    from: new Date(now - day),
    to: new Date(now + 365 * day),
  });
  // Few key-derivation rounds: node-forge is plain JavaScript, and the rounds don't change the format.
  const toP12 = (algorithm: string) =>
    Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(forge.pki.privateKeyFromPem(key.pkcs1), [forge.pki.certificateFromPem(passPem)], "s3cret", { algorithm, count: 16 })).getBytes(), "binary");
  p12Legacy = toP12("3des");
  p12Modern = toP12("aes256");
}, 60_000);

function ok(env: Record<string, string | undefined>): AppleSigner {
  const s = appleSigner(env);
  if (s instanceof AppleWalletSetupError) throw new Error(`expected a signer, got: ${s.message}`);
  return s;
}

function problem(env: Record<string, string | undefined>): string {
  const s = appleSigner(env);
  if (!(s instanceof AppleWalletSetupError)) throw new Error("expected a setup error");
  return s.message;
}

describe("Apple Wallet credentials", () => {
  it("reads plain PEM and takes the identifiers from the certificate", () => {
    const s = ok({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), APPLE_WWDR_CERT: wwdrPem });
    expect(s.passTypeIdentifier).toBe("pass.test.movescore");
    expect(s.teamIdentifier).toBe("TESTTEAM01");
    expect(s.signerKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(s.wwdr).toContain("BEGIN CERTIFICATE");
    expect(s.notes).toEqual([]);
  });

  it("reads `\\n` escapes, one-line PEM with spaces, quotes and CRLF", () => {
    const escaped = (p: string) => p.trim().replace(/\n/g, "\\n");
    const spaced = (p: string) => p.trim().replace(/\n/g, " ");
    ok({ APPLE_PASS_CERT: escaped(passPem), APPLE_PASS_KEY: escaped(key.pkcs1), APPLE_WWDR_CERT: escaped(wwdrPem) });
    ok({ APPLE_PASS_CERT: spaced(passPem), APPLE_PASS_KEY: spaced(key.pkcs1), APPLE_WWDR_CERT: spaced(wwdrPem) });
    ok({ APPLE_PASS_CERT: `"${passPem.replace(/\n/g, "\r\n")}"`, APPLE_PASS_KEY: `'${key.pkcs1}'`, APPLE_WWDR_CERT: wwdrPem });
  });

  it("reads base64 of a PEM file and base64 of DER (.cer) files", () => {
    ok({ APPLE_PASS_CERT: b64(passPem), APPLE_PASS_KEY: b64(key.pkcs1), APPLE_WWDR_CERT: b64(wwdrPem) });
    const pkcs8Der = key.privateKey.export({ type: "pkcs8", format: "der" });
    const pkcs1Der = key.privateKey.export({ type: "pkcs1", format: "der" });
    ok({ APPLE_PASS_CERT: b64(derOf(passPem)), APPLE_PASS_KEY: b64(pkcs8Der), APPLE_WWDR_CERT: b64(derOf(wwdrPem)) });
    ok({ APPLE_PASS_CERT: b64(derOf(passPem)), APPLE_PASS_KEY: b64(pkcs1Der), APPLE_WWDR_CERT: b64(derOf(wwdrPem)) });
  });

  it("opens encrypted keys with APPLE_PASS_KEY_PASSPHRASE (PKCS#8 and legacy PEM)", () => {
    const enc8 = key.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "s3cret" }).toString();
    const enc1 = key.privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-128-cbc", passphrase: "s3cret" }).toString();
    ok({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: enc8, APPLE_PASS_KEY_PASSPHRASE: "s3cret", APPLE_WWDR_CERT: wwdrPem });
    ok({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: enc1.trim().replace(/\n/g, "\\n"), APPLE_PASS_KEY_PASSPHRASE: "s3cret", APPLE_WWDR_CERT: wwdrPem });
    expect(problem({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: enc8, APPLE_PASS_KEY_PASSPHRASE: "wrong", APPLE_WWDR_CERT: wwdrPem })).toMatch(/APPLE_PASS_KEY_PASSPHRASE/);
  });

  it("reads a base64 .p12 (legacy and modern encryption) in either variable", () => {
    for (const p12 of [p12Legacy, p12Modern]) {
      ok({ APPLE_PASS_CERT: b64(p12), APPLE_PASS_KEY: b64(p12), APPLE_PASS_KEY_PASSPHRASE: "s3cret", APPLE_WWDR_CERT: wwdrPem });
      ok({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: b64(p12), APPLE_PASS_KEY_PASSPHRASE: "s3cret", APPLE_WWDR_CERT: wwdrPem });
    }
    expect(problem({ APPLE_PASS_CERT: b64(p12Modern), APPLE_PASS_KEY: b64(p12Modern), APPLE_PASS_KEY_PASSPHRASE: "nope", APPLE_WWDR_CERT: wwdrPem })).toMatch(/APPLE_PASS_KEY_PASSPHRASE/);
  });

  it("prefers the certificate's identifiers over mismatching env values, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = ok({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: key.pkcs1, APPLE_WWDR_CERT: wwdrPem, APPLE_PASS_TYPE_ID: "pass.org.mbeg.movescore", APPLE_TEAM_ID: "33C2U7Q76F" });
    expect(s.passTypeIdentifier).toBe("pass.test.movescore");
    expect(s.teamIdentifier).toBe("TESTTEAM01");
    expect(s.notes.join(" ")).toMatch(/APPLE_PASS_TYPE_ID.*APPLE_TEAM_ID/);
    warn.mockRestore();
  });

  it("names the variable that is wrong, without its value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(problem({ APPLE_PASS_CERT: "not a certificate!", APPLE_PASS_KEY: key.pkcs1, APPLE_WWDR_CERT: wwdrPem })).toMatch(/^APPLE_PASS_CERT is not a certificate/);
    expect(problem({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: "nope", APPLE_WWDR_CERT: wwdrPem })).toMatch(/^APPLE_PASS_KEY is not a private key/);
    expect(problem({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: other.pkcs1, APPLE_WWDR_CERT: wwdrPem })).toMatch(/does not belong/);
    // The test chain isn't Apple's, so without its own WWDR the bundled G4 can't vouch for it.
    expect(problem({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: key.pkcs1 })).toMatch(/APPLE_WWDR_CERT is not the Apple WWDR certificate/);
    expect(problem({ APPLE_PASS_CERT: wwdrPem, APPLE_PASS_KEY: key.pkcs1, APPLE_WWDR_CERT: wwdrPem })).toMatch(/no Pass Type ID certificate/);
    expect(problem({ APPLE_PASS_KEY: key.pkcs1 })).toMatch(/not set/);
    err.mockRestore();
  });

  it("refuses an expired certificate", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const later = new Date(Date.now() + 400 * day);
    const s = appleSigner({ APPLE_PASS_CERT: passPem, APPLE_PASS_KEY: key.pkcs1, APPLE_WWDR_CERT: wwdrPem }, later);
    expect(s).toBeInstanceOf(AppleWalletSetupError);
    expect((s as Error).message).toMatch(/expired/);
    err.mockRestore();
  });

  it("decodes nothing from junk", () => {
    expect(decodeCredential("")).toBeNull();
    expect(decodeCredential("hello world")).toBeNull();
    expect(decodeCredential("-----BEGIN CERTIFICATE----- no end")).toBeNull();
  });
});
