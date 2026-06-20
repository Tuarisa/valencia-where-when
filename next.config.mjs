/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Telegram / source CDNs serve the poster images; allow remote.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
    unoptimized: true,
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
