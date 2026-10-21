import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { developmentHostnames } from "./lib/server/dev-origin";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // Workbench browse paths end in "/" for their <base>; a 308 to drop it would break relative assets.
  skipTrailingSlashRedirect: true,
  experimental: { cpus: 1 },
  allowedDevOrigins: developmentHostnames(process.env.MARS_PUBLIC_ORIGIN),
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  distDir: process.env.MARS_BUILD_CHECK === "1" ? ".next-build" : ".next",
};

export default nextConfig;
