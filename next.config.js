const withPWA = require("next-pwa");

const env = process.env.NODE_ENV;
const isExport = process.env.NEXT_EXPORT === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(!isExport && {
    async rewrites() {
      return {
        beforeFiles: [
          {
            source: "/api/my_vanmoof_com/:path",
            destination: "https://my.vanmoof.com/api/v8/:path",
          },
          {
            source: "/api/api_vanmoof-api_com/:path",
            destination: "https://api.vanmoof-api.com/v8/:path",
          },
          {
            source:
              "/api/api_vanmoof-api_com/getBikeSharingInvitationsForBike/:path",
            destination:
              "https://api.vanmoof-api.com/v8/getBikeSharingInvitationsForBike/:path",
          },
          {
            source: "/api/api_vanmoof-api_com/revokeBikeSharingInvitation/:path",
            destination:
              "https://api.vanmoof-api.com/v8/revokeBikeSharingInvitation/:path",
          },
        ],
      };
    },
  }),
  images: {
    unoptimized: true,
  },
  pwa: {
    dest: "public",
  },
};

module.exports = env === "development" ? nextConfig : withPWA(nextConfig);
