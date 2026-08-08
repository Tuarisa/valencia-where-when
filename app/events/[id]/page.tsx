import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventRow, getSeriesDetail, eventPageUrl, seriesPageUrl } from "@/lib/queries";
import {
  deriveTitle,
  formatDateLabel,
  eventLocationLabel,
  loadTags,
  humanizeTag,
  usableImageUrl,
} from "@/lib/format";
import { cleanTags } from "@/lib/tags";
import { RichText, LinkButtons } from "../../detail-helpers";

export const dynamic = "force-dynamic";

// One DB query per request: generateMetadata and the page component share these via
// React cache() instead of each hitting the DB.
const cachedEventRow = cache(getEventRow);
const cachedSeriesDetail = cache(getSeriesDetail);

const BASE_URL = process.env.APP_BASE_URL || "https://valencia-where-when.vercel.app";

// First ~160 chars of the (RU-preferred) description for <meta name="description"> /
// og:description, cut at a word boundary. undefined when there's no real description —
// we never fabricate one.
const META_DESC_LIMIT = 160;
function metaDescription(row: Record<string, any>): string | undefined {
  const text = String(row.description_ru || row.description || "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= META_DESC_LIMIT) return text;
  let cut = text.slice(0, META_DESC_LIMIT);
  const space = cut.lastIndexOf(" ");
  if (space > META_DESC_LIMIT * 0.5) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:—–-]+$/, "") + "…";
}

// Plain title (the root layout's title.template appends the site suffix) + canonical
// /events/<id>-<slug> href built by the SAME helper the feed cards use. Relative URLs —
// the layout's metadataBase resolves them.
function buildEventMetadata(row: Record<string, any>, href: string): Metadata {
  const title = row.title_ru || deriveTitle(row.title, 120);
  const description = metaDescription(row);
  const image = usableImageUrl(row.image_url);
  return {
    title,
    description,
    alternates: { canonical: href },
    openGraph: {
      title,
      description,
      url: href,
      type: "article",
      ...(image ? { images: [image] } : {}),
    },
  };
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  if (params.id.startsWith("series-")) {
    const seriesId = Number(params.id.split("-")[1]);
    const detail = Number.isFinite(seriesId) ? await cachedSeriesDetail(seriesId) : null;
    if (!detail) return { title: "Событие не найдено" };
    return buildEventMetadata(detail.series, seriesPageUrl(detail.series));
  }
  const id = Number(params.id.split("-")[0]);
  const row = Number.isFinite(id) ? await cachedEventRow(id) : null;
  if (!row) return { title: "Событие не найдено" };
  return buildEventMetadata(row, eventPageUrl(row));
}

// schema.org Event JSON-LD. Emits ONLY real DB fields — anything null/unknown is
// omitted, never fabricated. Dates stay the plain YYYY-MM-DD strings from the DB
// (start_time appended when present); price is passed through as-is, with
// priceCurrency EUR only when the string itself says euros.
function eventJsonLd(row: Record<string, any>, href: string): string {
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: row.title_ru || deriveTitle(row.title, 120),
    url: `${BASE_URL}${href}`,
  };
  if (row.start_date)
    data.startDate = row.start_time ? `${row.start_date}T${row.start_time}` : row.start_date;
  if (row.end_date) data.endDate = row.end_date;
  const description = metaDescription(row);
  if (description) data.description = description;
  const image = usableImageUrl(row.image_url);
  if (image) data.image = image;
  if (row.venue_name || row.address) {
    const location: Record<string, unknown> = { "@type": "Place" };
    if (row.venue_name) location.name = row.venue_name;
    if (row.address) location.address = row.address;
    data.location = location;
  }
  if (row.price) {
    const offer: Record<string, unknown> = { "@type": "Offer", price: String(row.price) };
    if (/€|eur/i.test(String(row.price))) offer.priceCurrency = "EUR";
    data.offers = offer;
  }
  // Escape < so scraped text can't break out of the <script> tag.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function EventPage({ params }: { params: { id: string } }) {
  // Recurring series detail (T043): /events/series-<id>-<slug> renders the series card
  // PLUS its full occurrence schedule (the dated sessions). Ordinary single-shot events
  // keep the numeric-id path below.
  if (params.id.startsWith("series-")) {
    const seriesId = Number(params.id.split("-")[1]);
    if (!Number.isFinite(seriesId)) notFound();
    const detail = await cachedSeriesDetail(seriesId);
    if (!detail) notFound();
    return <SeriesDetail detail={detail} />;
  }

  const id = Number(params.id.split("-")[0]);
  if (!Number.isFinite(id)) notFound();
  const row = await cachedEventRow(id);
  if (!row) notFound();

  const headline = row.title_ru || deriveTitle(row.title, 120);
  const bodyText =
    row.description_ru || row.description || row.raw_excerpt ||
    "Описание пока короткое, но запись уже в каталоге.";
  const tags = cleanTags(loadTags(row.tags_json));

  const links: { label: string; href: string; ghost?: boolean }[] = [];
  if (row.source_url || row.url) links.push({ label: "Источник", href: row.source_url || row.url });
  if (row.url && row.url !== row.source_url) links.push({ label: "Открыть источник", href: row.url });
  if (row.venue_url) links.push({ label: "Локация", href: row.venue_url, ghost: true });

  return (
    <main className="detail-page detail-shell">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: eventJsonLd(row, eventPageUrl(row)) }}
      />
      <Link className="back-link" href="/">← назад к ленте</Link>
      <article className="detail-card">
        <p className="eyebrow">Событие</p>
        <h1>{headline}</h1>
        <div className="meta-grid">
          <div><strong>Когда</strong><span>{formatDateLabel(row.start_date, row.end_date, row.start_time)}</span></div>
          <div><strong>Где</strong><span>{eventLocationLabel(row)}</span></div>
          <div><strong>Категория</strong><span>{row.category || "other"}</span></div>
          <div><strong>Score</strong><span>{row.score ?? "—"}</span></div>
        </div>
        <div className="tags-row">
          {tags.map((t) => <span key={t} className="tag">{humanizeTag(t)}</span>)}
        </div>
        {usableImageUrl(row.image_url) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="detail-image" src={usableImageUrl(row.image_url)!} alt={headline} />
        )}
        <p className="detail-copy"><RichText text={bodyText} /></p>
        <div className="button-row">
          {links.map((l, i) => (
            <a key={i} className={l.ghost ? "button button-ghost" : "button"} href={l.href} target="_blank" rel="noreferrer">{l.label}</a>
          ))}
          <LinkButtons linksJson={row.links_json} />
        </div>
      </article>
    </main>
  );
}

// Series detail (T043): the series card + its full session schedule grouped by date.
function SeriesDetail({
  detail,
}: {
  detail: { series: Record<string, any>; occurrences: Record<string, any>[] };
}) {
  const { series, occurrences } = detail;
  const headline = series.title_ru || deriveTitle(series.title, 120);
  const bodyText =
    series.description_ru || series.description || series.raw_excerpt ||
    "Описание пока короткое, но запись уже в каталоге.";
  const tags = cleanTags(loadTags(series.tags_json));

  const links: { label: string; href: string; ghost?: boolean }[] = [];
  if (series.source_url || series.url) links.push({ label: "Источник", href: series.source_url || series.url });
  if (series.url && series.url !== series.source_url) links.push({ label: "Открыть источник", href: series.url });
  if (series.venue_url) links.push({ label: "Локация", href: series.venue_url, ghost: true });

  // Group sessions by date so the schedule reads "date → [times]".
  const byDate = new Map<string, string[]>();
  for (const o of occurrences) {
    const d = o.occurrence_date || "—";
    if (!byDate.has(d)) byDate.set(d, []);
    if (o.start_time) byDate.get(d)!.push(o.start_time);
  }
  const days = Array.from(byDate.keys()).sort();

  return (
    <main className="detail-page detail-shell">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: eventJsonLd(series, seriesPageUrl(series)) }}
      />
      <Link className="back-link" href="/">← назад к ленте</Link>
      <article className="detail-card">
        <p className="eyebrow">Серия · {occurrences.length} {pluralSeans(occurrences.length)}</p>
        <h1>{headline}</h1>
        <div className="meta-grid">
          <div><strong>Когда</strong><span>{formatDateLabel(series.start_date, series.end_date, null)}</span></div>
          <div><strong>Где</strong><span>{eventLocationLabel(series)}</span></div>
          <div><strong>Категория</strong><span>{series.category || "other"}</span></div>
          <div><strong>Score</strong><span>{series.score ?? "—"}</span></div>
        </div>
        <div className="tags-row">
          {tags.map((t) => <span key={t} className="tag">{humanizeTag(t)}</span>)}
        </div>
        {usableImageUrl(series.image_url) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="detail-image" src={usableImageUrl(series.image_url)!} alt={headline} />
        )}
        <p className="detail-copy"><RichText text={bodyText} /></p>
        <section className="series-schedule">
          <h2>Расписание</h2>
          <ul>
            {days.map((d) => (
              <li key={d}>
                <strong>{formatDateLabel(d, null, null)}</strong>
                {byDate.get(d)!.length > 0 && <span> · {byDate.get(d)!.join(" · ")}</span>}
              </li>
            ))}
          </ul>
        </section>
        <div className="button-row">
          {links.map((l, i) => (
            <a key={i} className={l.ghost ? "button button-ghost" : "button"} href={l.href} target="_blank" rel="noreferrer">{l.label}</a>
          ))}
          <LinkButtons linksJson={series.links_json} />
        </div>
      </article>
    </main>
  );
}

function pluralSeans(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "сеанс";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "сеанса";
  return "сеансов";
}
