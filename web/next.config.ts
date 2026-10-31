import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // DB 장애 시 폴백용 번들 JSON 을 서버리스 함수에 포함
  outputFileTracingIncludes: {
    "/api/snapshot": ["./src/data/generated/**/*"],
  },
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
