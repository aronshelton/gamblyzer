/** @type {import('next').NextConfig} */
const nextConfig = {
  /** Reduces PackFileCacheStrategy / missing-chunk issues when using `next dev` with Webpack. */
  webpack: (config, { dev }) => {
    if (dev) {
      config.cache = { type: "memory" };
    }
    return config;
  },
};

export default nextConfig;
