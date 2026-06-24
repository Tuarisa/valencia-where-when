import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventRow, getSeriesDetail } from "@/lib/queries";
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

export default async function EventPage({ params }: { params: { id: string } }) {
  // Recurring series detail (T043): /events/series-<id>-<slug> renders the series card
  // PLUS its full occurrence schedule (the dated sessions). Ordinary single-shot events
  // keep the numeric-id path below.
  if (params.id.startsWith("series-")) {
    const seriesId = Number(params.id.split("-")[1]);
    if (!Number.isFinite(seriesId)) notFound();
    const detail = await getSeriesDetail(seriesId);
    if (!detail) notFound();
    return <SeriesDetail detail={detail} />;
  }

  const id = Number(params.id.split("-")[0]);
  if (!Number.isFinite(id)) notFound();
  const row = await getEventRow(id);
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
