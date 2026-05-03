import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the Next.js dev-mode badge (the "N" circle bottom-left).
  // Errors and warnings still surface normally.
  devIndicators: false,
};

export default nextConfig;
