/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      {
        source: "/research.html",
        destination: "/research/evaluating-and-developing-agents",
        permanent: true,
      },
      {
        source: "/papers",
        destination: "/resources/papers",
        permanent: true,
      },
      {
        source: "/papers/:slug",
        destination: "/resources/papers/:slug",
        permanent: true,
      },
      {
        source: "/demo-day",
        destination: "/companies",
        permanent: false,
      },
      {
        source: "/demo-day/:path*",
        destination: "/companies",
        permanent: false,
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
