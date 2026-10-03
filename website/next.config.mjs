/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the traced root to this project; the repo also holds the desktop app's
  // own lockfile at the parent level.
  outputFileTracingRoot: import.meta.dirname,
  images: {
    formats: ['image/avif', 'image/webp'],
  },
};

export default nextConfig;
