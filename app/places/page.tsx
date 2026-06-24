import Link from "next/link";
import { getPlaces } from "@/lib/queries";
import { humanizeTag, usableImageUrl } from "@/lib/format";

// Places catalog (sub-area F, T063). A browsable, FILTERABLE surface for the places
// the pipeline + the logunespa crawl collect — distinct from the events feed
// (Constitution III: places are first-class, independent of events). Server-rendered
// and DETERMINISTIC: facets are plain query-string links (?category=/?area=/?tag=/?q=),
// so the page renders the same from the DB with no client JS (Constitution: "site
// renders deterministically from the DB").
export const dynamic = "force-dynamic";
export const revalidate = 0;

type SP = Record<string, string | string[] | undefined>;
const one = (v?: string | string[]): string => (Array.isArray(v) ? v[0] : v) || "";
const norm = (s?: string | null): string => (s || "").trim();

export default async function PlacesPage({ searchParams }: { searchParams: SP }) {
  const places = await getPlaces();

  const category = one(searchParams.category);
  const area = one(searchParams.area);
  const tag = one(searchParams.tag);
  const q = one(searchParams.q).trim().toLowerCase();

  // Facets derived from the data itself.
  const categories = Array.from(new Set(places.map((p) => norm(p.category)).filter(Boolean))).sort();
  const areas = Array.from(
    new Set(places.map((p) => norm(p.area) || norm(p.district)).filter(Boolean)),
  ).sort();
  const tagCount = new Map<string, number>();
  for (const p of places) for (const t of p.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([t]) => t);

  const filtered = places.filter((p) => {
    if (category && norm(p.category) !== category) return false;
    if (area && (norm(p.area) || norm(p.district)) !== area) return false;
    if (tag && !p.tags.includes(tag)) return false;
    if (q) {
      const hay = `${p.name} ${p.excerpt} ${p.location_label} ${p.category || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Build an href that keeps the other active facets and toggles `key`: clicking the
  // currently-selected value clears it; an empty `val` is the "Все" (reset) chip.
  const cur: Record<string, string> = { category, area, tag };
  const hrefWith = (key: string, val: string): string => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(cur)) if (v && k !== key) params.set(k, v);
    if (q) params.set("q", q);
    if (val && cur[key] !== val) params.set(key, val);
    const s = params.toString();
    return s ? `/places?${s}` : "/places";
  };

  // Plain render helper (NOT a component) — avoids React's reserved `key` prop, and the
  // map keys below stay real React keys.
  const renderFacet = (label: string, items: string[], param: string, active: string) =>
    items.length ? (
      <div className="facet">
        <p className="eyebrow">{label}</p>
        <div className="tag-strip">
          <Link className={`tag-button${active ? "" : " is-active"}`} href={hrefWith(param, "")}>Все</Link>
          {items.map((v) => (
            <Link
              key={v}
              className={`tag-button${active === v ? " is-active" : ""}`}
              href={hrefWith(param, v)}
            >
              {param === "tag" ? humanizeTag(v) : v}
            </Link>
          ))}
        </div>
      </div>
    ) : null;

  return (
    <main className="page-shell">
      <header className="panel">
        <Link className="back-link" href="/">← назад к ленте</Link>
        <p className="eyebrow">каталог</p>
        <h2>Места Валенсии</h2>
        <p className="panel-note">
          {filtered.length} из {places.length} мест
          {(category || area || tag || q) ? " · по фильтру" : ""}
        </p>

        <form className="toolbar" action="/places" method="get">
          {category && <input type="hidden" name="category" value={category} />}
          {area && <input type="hidden" name="area" value={area} />}
          {tag && <input type="hidden" name="tag" value={tag} />}
          <input className="search" type="search" name="q" defaultValue={q} placeholder="Поиск по названию, описанию, району…" />
        </form>

        {renderFacet("Категория", categories, "category", category)}
        {renderFacet("Район", areas, "area", area)}
        {renderFacet("Тег", topTags, "tag", tag)}
      </header>

      <section className="panel">
        {filtered.length === 0 ? (
          <p className="panel-note">Ничего не нашлось — попробуй сбросить фильтр.</p>
        ) : (
          <div className="places-list">
            {filtered.map((item) => {
              const img = usableImageUrl(item.image_url);
              return (
              <article key={item.id} className="place-card">
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img} alt="" />
                ) : (
                  <div className="card-visual placeholder" />
                )}
                <div>
                  <h3>{item.name}</h3>
                  <p>{item.location_label}</p>
                  {item.excerpt && <p>{item.excerpt}</p>}
                  <div className="tags-row">
                    {item.tags.map((t) => (
                      <span key={t} className="tag">{humanizeTag(t)}</span>
                    ))}
                  </div>
                  <div className="card-actions">
                    <Link className="card-link" href={item.page_url}>Открыть карточку →</Link>
                    {(item.source_url || item.maps_url) && (
                      <a className="card-link" href={item.source_url || item.maps_url || "#"} target="_blank" rel="noreferrer">Источник ↗</a>
                    )}
                  </div>
                </div>
              </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
