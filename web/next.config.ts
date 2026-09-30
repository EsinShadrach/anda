import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Production is a static export (served by nginx in the anda-web container), so there's no
// Node process on the VM. In dev, /api and /media are proxied to the Go server on :8080.
const config: NextConfig = isDev
  ? {
      // 127.0.0.1 is a second cookie jar on the same machine: two users in one browser.
      allowedDevOrigins: ["127.0.0.1"],
      async rewrites() {
        return [
          { source: "/api/:path*", destination: "http://localhost:8080/api/:path*" },
          { source: "/media/:path*", destination: "http://localhost:8080/media/:path*" },
        ];
      },
    }
  : { output: "export", images: { unoptimized: true } };

export default config;
