import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // src/proxy.ts (Basic Auth) makes Next buffer request bodies, and by default it silently truncates
    // them at 10 MB. Remix sources (up to 500 MB, see MAX_SOURCE_BYTES) and dataset photos need more.
    proxyClientMaxBodySize: "520mb",
  },
};

export default nextConfig;
