/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/og-image.png",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/favicon.ico",
        headers: [{ key: "Cache-Control", value: "public, max-age=604800" }],
      },
      {
        source: "/public-ai-logo.png",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/research.html",
        destination: "/research/evaluating-and-developing-agents",
        permanent: true,
      },
    ];
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ["chromadb", "chromadb-default-embed"],
    outputFileTracingIncludes: {
      '/**/*': ['./schools/**/*', './evaluations/**/*'],
    }
  },
};

module.exports = nextConfig;
