import type { NextConfig } from "next";

// Branded files read our logos, fonts and flags from public/ on the server (Excel images,
// share PNGs): make sure those functions carry them (src/lib/brand/server.ts, shareCard.tsx).
const BRAND_FILES = ["./public/brand/**/*", "./public/email/move-score-lockup@2x.png"];

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/qr/coaches/share": [...BRAND_FILES, "./public/flags/**/*"],
    "/qr/courts/share": BRAND_FILES,
    "/api/tournaments/\\[id\\]/export": BRAND_FILES,
    "/api/mobile/v1/referee/tournaments/\\[id\\]/lineups/template": BRAND_FILES,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  async headers() {
    // The app's routes authenticate with explicit tokens, never cookies, so a
    // wildcard origin is safe (browsers never send cookies to "*"). It lets the
    // app's web build and previews call the API.
    const cors = [
      { key: "Access-Control-Allow-Origin", value: "*" },
      { key: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, DELETE, OPTIONS" },
      { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, X-Install-Token, X-Staff-Token, X-Device-Id" },
      { key: "Access-Control-Max-Age", value: "86400" },
    ];
    return [
      { source: "/api/mobile/:path*", headers: cors },
      { source: "/api/matches/:path*", headers: cors },
      { source: "/flags/:file*", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }, { key: "Cache-Control", value: "public, max-age=604800" }] },
      {
        // A released voice pack never changes: any new recording ships under a new
        // version folder, so phones may keep the 5 MB download for good. The
        // development pack (en-dev) is left out, since it is rebuilt in place.
        source: "/voice/:pack(en-v\\d+)/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
