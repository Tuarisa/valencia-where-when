import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventRow } from "@/lib/queries";
import {
  deriveTitle,
  formatDateLabel,
  eventLocationLabel,
  loadTags,
  humanizeTag,
} from "@/lib/format";
import { RichText, LinkButtons } from "../../detail-helpers";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: { id: string } }) {
  const id = Number(params.id.split("-")[0]);
  if (!Number.isFinite(id)) notFound();
  const row = await getEventRow(id);
  if (!row) notFound();

  const headline = row.title_ru || deriveTitle(row.title, 120);
  const bodyText =
    row.description_ru || row.description || row.raw_excerpt ||
    "Описание пока короткое, но запись уже в каталоге.";
  const tags = loadTags(row.tags_json);

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
        {row.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="detail-image" src={row.image_url} alt={headline} />
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
