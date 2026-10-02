/**
 * Android App Links for Move Score: lets the app verify it may open
 * https://<this host>/v/* (the venue QR code; see the intentFilters entry in
 * move-score-app/app.config.ts, which sets autoVerify).
 *
 * OWNER TO FILL: SHA256_CERT_FINGERPRINTS is empty until the Play app signing key
 * exists. After the first upload to Google Play, copy the "SHA-256 certificate
 * fingerprint" from Play Console → Test and release → App integrity → App signing
 * (and, for builds installed outside Play, the EAS upload key from `eas credentials`)
 * in the form "AB:CD:...". With an empty list the file is valid JSON but Android
 * verifies nothing, so /v/ links open in the browser instead of the app.
 */
export const dynamic = "force-static";

const PACKAGE_NAME = "org.mbeg.movescore";
const SHA256_CERT_FINGERPRINTS: string[] = [];

export function GET() {
  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: PACKAGE_NAME, sha256_cert_fingerprints: SHA256_CERT_FINGERPRINTS },
    },
  ];
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
}
