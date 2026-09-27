/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Enables the minimal, self-contained `.next/standalone` server bundle
  // used by the production Docker image (see frontend/Dockerfile).
  output: "standalone",
};

module.exports = nextConfig;
