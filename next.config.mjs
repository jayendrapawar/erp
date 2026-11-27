/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Type errors must fail the build (audit finding A4).
    ignoreBuildErrors: false,
  },
  // Allow local network devices (phones, tablets on the same Wi-Fi) to
  // access HMR/webpack dev resources without the cross-origin block warning.
  allowedDevOrigins: [
    '192.168.29.112',
    '192.168.*.*',
  ],
  // Send the extra production alias to the primary domain so the Google OAuth
  // callback and session cookie always live on the same host.
  // localhost is deliberately NOT redirected, so the app can run on a laptop.
  async redirects() {
    return ['shayona-inventory-managment.vercel.app'].map((host) => ({
      source: '/:path*',
      has: [{ type: 'host', value: host }],
      destination: 'https://shayona-footwear.vercel.app/:path*',
      permanent: false,
    }))
  },
}

export default nextConfig