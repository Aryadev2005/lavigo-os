import type { NextConfig } from "next";

// Strict CSP (system design §9, NFR-4): self, Google Fonts, data:/blob: images, no framing.
// 'unsafe-inline' for styles is needed by next/font and React style props;
// 'unsafe-eval' only in dev for React refresh.
const isDev = process.env.NODE_ENV !== "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Keep the dev badge off the sidebar footer.
  devIndicators: { position: "bottom-right" },
  experimental: {
    // Enables forbidden() → src/app/forbidden.tsx (403) for role checks in requireUser().
    authInterrupts: true,
    // Ticket PDFs (TKT-7) and chat attachments go through server actions: 10 MB per file, 20 MB per confirm.
    serverActions: { bodySizeLimit: "21mb" },
  },
  serverExternalPackages: ["@node-rs/argon2", "pino", "bullmq", "ioredis", "@react-pdf/renderer"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // HSTS only in production builds (Caddy serves HTTPS there); never on dev's http://localhost.
          ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default nextConfig;
