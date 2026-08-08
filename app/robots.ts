import type { MetadataRoute } from "next";

const baseUrl = process.env.APP_BASE_URL ?? "https://valencia-where-when.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
