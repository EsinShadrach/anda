import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Production is a static export (served by nginx in the anda-web container), so there's no
// Node process on the VM. In dev, /api is proxied to the Go server on :8080.
const config: NextConfig = isDev
  ? {
      async rewrites() {
        return [{ source: "/api/:path*", destination: "http://localhost:8080/api/:path*" }];
      },
    }
  : { output: "export", images: { unoptimized: true } };

export default config;
