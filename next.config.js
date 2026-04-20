/** @type {import('next').NextConfig} */
const nextConfig = {
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
