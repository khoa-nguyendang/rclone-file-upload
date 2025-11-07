import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: 'standalone',

  // Base path configuration for proxy deployment
  // This will be used when the app is deployed behind a proxy
  // IMPORTANT: Use BASE_PATH not NEXT_PUBLIC_BASE_PATH for build-time config
  basePath: process.env.BASE_PATH || '',

  // Asset prefix for static files when behind proxy
  assetPrefix: process.env.ASSET_PREFIX || '',

  // Allow external API calls
  async rewrites() {
    // Only use rewrites in local development
    if (process.env.NODE_ENV === 'development') {
      return [
        {
          source: '/api/server/:path*',
          destination: 'http://localhost:8080/api/:path*',
        },
      ];
    }
    return [];
  },

  // Handle trailing slashes consistently
  trailingSlash: false,

  // Ensure images work with base path
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
