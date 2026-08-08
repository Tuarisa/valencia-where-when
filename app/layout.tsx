import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

// SEO base: absolute URL for canonical/OG resolution; pages set RELATIVE
// alternates.canonical / openGraph.url against it and plain titles (template adds suffix).
const baseUrl = process.env.APP_BASE_URL ?? "https://valencia-where-when.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(baseUrl),
  title: { default: "Valencia Radar", template: "%s — Valencia Radar" },
  description:
    "Афиша, места и нотификации по Валенсии: русскоязычные события, городские фестивали, шоу. Лента, теги, календарь и карта.",
  openGraph: { siteName: "Valencia Radar", locale: "ru_RU", type: "website" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;700;800&family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap"
          rel="stylesheet"
        />
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
          crossOrigin=""
        />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
