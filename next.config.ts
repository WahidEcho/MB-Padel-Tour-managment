import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  async headers() {
    return [
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
