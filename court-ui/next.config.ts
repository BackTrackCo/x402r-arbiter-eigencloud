import type { NextConfig } from "next";

const arbiterUrl = process.env.ARBITER_BACKEND_URL || "http://34.168.46.192:3000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/arbiter/:path*",
        destination: `${arbiterUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
