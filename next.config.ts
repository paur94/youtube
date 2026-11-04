import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Quick tunnels (cloudflared) used to reach the dev server over https, e.g. for TikTok's OAuth callback.
  allowedDevOrigins: ["*.trycloudflare.com"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
