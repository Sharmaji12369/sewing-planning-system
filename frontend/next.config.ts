import type { NextConfig } from "next";

// The browser only ever talks to this Next.js server. Anything under /api is
// passed through to the Node backend, so there is one address to open and no
// cross-origin setup.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // A second copy (for trying changes while the live site runs from .next) builds elsewhere.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
};

export default nextConfig;
