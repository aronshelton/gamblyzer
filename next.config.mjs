/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Used by `next dev` (default in package.json). Turbopack (`npm run dev:turbopack`) skips this hook and has
   * seen ENOENT races on `.next/static/development/_buildManifest.js.tmp.*` when compiling API routes.
   */
  webpack: (config, { dev }) => {
    if (dev) {
      config.cache = { type: "memory" };
    }
    return config;
  },
};

export default nextConfig;
