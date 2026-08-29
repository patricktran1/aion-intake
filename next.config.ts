import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Photos are held as data URLs inside the in-memory demo store; keep the
  // body limit generous enough for three phone photos but not unbounded.
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
