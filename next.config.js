/** @type {import('next').NextConfig} */
const nextConfig = {
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
