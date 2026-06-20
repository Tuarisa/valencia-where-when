import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlaceRow } from "@/lib/queries";
import { placeLocationLabel, loadTags, humanizeTag } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PlacePage({ params }: { params: { id: string } }) {
  const id = Number(params.id.split("-")[0]);
  if (!Number.isFinite(id)) notFound();
  const row = await getPlaceRow(id);
  if (!row) notFound();

  const tags = loadTags(row.tags_json);
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
        {row.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="detail-image" src={row.image_url} alt={row.name} />
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
