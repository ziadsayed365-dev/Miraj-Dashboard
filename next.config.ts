import type { NextConfig } from "next";

// The report PDF (src/lib/report-pdf.ts) needs the serverless Chromium's binary
// and the Arabic font, neither of which is imported, so neither would be traced.
const pdfFiles = ["./node_modules/@sparticuz/chromium/bin/**/*", "./src/lib/pdf-fonts/**/*"];

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/agent/webhook": pdfFiles,
    "/api/agent/nightly": pdfFiles,
  },
};

export default nextConfig;
