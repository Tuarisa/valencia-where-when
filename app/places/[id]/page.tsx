import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlaceRow } from "@/lib/queries";
import { placeLocationLabel, loadTags, humanizeTag, usableImageUrl, pageSlug } from "@/lib/format";
import { cleanTags } from "@/lib/tags";

export const dynamic = "force-dynamic";

// generateMetadata and the page body both need the row — React cache() dedupes
// that to one DB read per request.
const getPlace = cache(getPlaceRow);

const parseId = (param: string): number => Number(param.split("-")[0]);

// ~160-char meta description, cut on a word boundary (same cut rule as deriveTitle).
function metaDescription(text: string, limit = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  let cut = clean.slice(0, limit).replace(/\s+$/, "");
  const space = cut.lastIndexOf(" ");
  if (space > limit * 0.5) cut = cut.slice(0, space);
  return cut + "…";
}

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const id = parseId(params.id);
  const row = Number.isFinite(id) ? await getPlace(id) : null;
  if (!row) return { title: "Место не найдено" };

  const description = metaDescription(
    row.description ||
      row.notes ||
      `${row.category || "Место"} · ${placeLocationLabel(row)} — в каталоге мест Valencia Radar.`,
  );
  // Canonical = the slugged URL the site itself links to (toSitePlace.page_url),
  // relative — layout's metadataBase resolves it.
  const canonical = `/places/${row.id}-${pageSlug(row.name, `place-${row.id}`)}`;
  const image = usableImageUrl(row.image_url);
  return {
    title: row.name, // plain — the layout title.template appends "— Valencia Radar"
    description,
    alternates: { canonical },
    openGraph: {
      title: row.name,
      description,
      url: canonical,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function PlacePage({ params }: { params: { id: string } }) {
  const id = parseId(params.id);
  if (!Number.isFinite(id)) notFound();
  const row = await getPlace(id);
  if (!row) notFound();

  const tags = cleanTags(loadTags(row.tags_json));
  const coords =
    row.lat != null && row.lng != null ? `${row.lat}, ${row.lng}` : "ещё нет";

  const links: { label: string; href: string; ghost?: boolean }[] = [];
  if (row.source_url || row.url) links.push({ label: "Источник", href: row.source_url || row.url });
  if (row.maps_url) links.push({ label: "Открыть карту", href: row.maps_url, ghost: true });

  return (
    <main className="detail-page detail-shell">
      <Link className="back-link" href="/">← назад к ленте</Link>
      <article className="detail-card">
        <p className="eyebrow">Место</p>
        <h1>{row.name}</h1>
        <div className="meta-grid">
          <div><strong>Где</strong><span>{placeLocationLabel(row)}</span></div>
          <div><strong>Категория</strong><span>{row.category || "place"}</span></div>
          <div><strong>Источник</strong><span>{row.source || "—"}</span></div>
          <div><strong>Координаты</strong><span>{coords}</span></div>
        </div>
        <div className="tags-row">
          {tags.map((t) => <span key={t} className="tag">{humanizeTag(t)}</span>)}
        </div>
        {usableImageUrl(row.image_url) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="detail-image" src={usableImageUrl(row.image_url)!} alt={row.name} />
        )}
        <p className="detail-copy">
          {row.description || row.notes || "Место уже в каталоге; описание ещё будем вычищать и обогащать."}
        </p>
        <div className="button-row">
          {links.map((l, i) => (
            <a key={i} className={l.ghost ? "button button-ghost" : "button"} href={l.href} target="_blank" rel="noreferrer">{l.label}</a>
          ))}
        </div>
      </article>
    </main>
  );
}
