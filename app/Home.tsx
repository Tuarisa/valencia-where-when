"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SitePayload, SiteEvent, SitePlace } from "@/lib/queries";
import { humanizeTag, usableImageUrl } from "@/lib/format";
import { canonicalCategory, categoryLabelRu } from "@/lib/categories";

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function pluralSeans(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "сеанс";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "сеанса";
  return "сеансов";
}

// Category-filter chip labels (T163/T178) now come from the shared, DB-free
// lib/categories.ts: canonicalCategory() collapses EN/RU + singular/plural + casing
// to ONE canonical RU key, categoryLabelRu() renders the display label.

// Initial feed batch + per-load increment for the lazy feed (T163).
const FEED_BATCH = 30;

function matchesSearch(item: { title?: string; name?: string; description?: string | null; excerpt?: string; location_label?: string; tags: string[] }, search: string): boolean {
  if (!search) return true;
  const hay = [
    item.title || item.name || "",
    item.description || "",
    item.excerpt || "",
    item.location_label || "",
    ...(item.tags || []),
  ].join(" ").toLowerCase();
  return hay.includes(search);
}

// Escape dynamic text for the Leaflet popup HTML strings.
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

// Human-readable map popup (T135): a real title (fall back when the name is still a raw
// maps link), a category chip, and a short "why-go" line — not just name + location.
function placePopupHtml(p: SitePlace): string {
  const named = p.name && !/^https?:/i.test(p.name);
  const title = named ? p.name : p.category ? p.category[0].toUpperCase() + p.category.slice(1) : "Место";
  const cat = p.category ? ` <span class="map-cat">${esc(p.category)}</span>` : "";
  const why = p.excerpt ? `<div class="map-why">${esc(p.excerpt)}</div>` : "";
  return `<strong>${esc(title)}</strong>${cat}<br><span class="map-loc">${esc(p.location_label)}</span>${why}<br><a href="${p.page_url}">карточка →</a>`;
}

function eventPopupHtml(e: SiteEvent): string {
  const why = e.excerpt ? `<div class="map-why">${esc(e.excerpt)}</div>` : "";
  return `<strong>${esc(e.title)}</strong><br><span class="map-loc">${esc(e.date_label)}</span>${why}<br><a href="${e.page_url}">карточка →</a>`;
}

export default function Home({ payload }: { payload: SitePayload }) {
  const [search, setSearch] = useState("");
  // "" = no tag filter. NOT "all" — a real data tag is literally named "all" (fever/
  // ticketmaster), which would collide with the sentinel. loadTags() drops falsy tags,
  // so "" can never be a real tag.
  const [tag, setTag] = useState("");
  const [category, setCategory] = useState("all");
  const [monthIndex, setMonthIndex] = useState(() =>
    Math.max(0, payload.months.indexOf(payload.default_month || "")),
  );

  const s = search.trim().toLowerCase();
  const matchesTag = (tags: string[]) => tag === "" || tags.includes(tag);
  // An event matches the selected category iff its CANONICAL key equals the selected
  // canonical key (the chip values are canonical keys from buildCategories) (T178).
  const matchesCategory = (cat: string | null) =>
    category === "all" || canonicalCategory(cat) === category;

  // The FEED shows ordinary events + ONE card per series; calendar-only occurrence
  // rows (sub-area D, T043) are bucketed onto the calendar, never listed as feed cards.
  // Tag-cloud + category-chip filters combine as AND (T163).
  const filteredEvents = useMemo(
    () =>
      payload.events.filter(
        (e) =>
          !e.calendar_only &&
          matchesSearch(e, s) &&
          matchesTag(e.tags) &&
          matchesCategory(e.category),
      ),
    [payload.events, s, tag, category],
  );
  // Places are filtered by search + tag only (they have no event category).
  const filteredPlaces = useMemo(
    () => payload.places.filter((p) => matchesSearch(p, s) && matchesTag(p.tags)),
    [payload.places, s, tag],
  );

  const filterActive = tag !== "" || category !== "all" || s !== "";
  const clearFilters = () => { setTag(""); setCategory("all"); setSearch(""); };

  return (
    <div className="page-shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">витрина</p>
          <h1>Valencia Radar</h1>
          <p className="hero-text">
            Один каталог для афиши, мест и будущих нотификаций. Лента, теги, календарь и карта —
            русскоязычные события, городские фестивали и шоу в Валенсии и округе.
          </p>
        </div>
        <div className="hero-stats">
          <div className="stat-card"><strong>{payload.stats.events}</strong><span>событий</span></div>
          <div className="stat-card"><strong>{payload.stats.places}</strong><span>мест</span></div>
          <div className="stat-card"><strong>{payload.stats.mapped_places}</strong><span>мест на карте</span></div>
          <div className="stat-card"><strong>{payload.stats.tag_count}</strong><span>уникальных тегов</span></div>
        </div>
      </header>

      <section className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Поиск по событиям, местам, тегам"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="facet">
          <p className="eyebrow">категории</p>
          <CategoryFilter
            categories={payload.categories}
            active={category}
            onSelect={setCategory}
          />
        </div>
        <div className="facet">
          <p className="eyebrow">облако тегов</p>
          <TagCloud tags={payload.tag_cloud} active={tag} onSelect={setTag} />
        </div>
      </section>

      <main className="layout">
        {/* T191: when ANY filter is active (category / tag / search), hide the calendar +
            map block so the FEED surfaces directly under the filter bar — clicking a chip
            shouldn't scroll the result far below the calendar + map. Restored when the
            filter is cleared (the «сбросить фильтры» button below resets all three). */}
        {!filterActive && (
          <div className="top-row">
            <Calendar
              payload={payload}
              monthIndex={monthIndex}
              setMonthIndex={setMonthIndex}
            />
            <MapPanel events={payload.events.filter((e) => !e.calendar_only)} places={filteredPlaces} center={payload.map_center} />
          </div>
        )}

        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">лента</p>
              <h2>Отфильтрованные события</h2>
            </div>
            <p className="panel-note">{filteredEvents.length} шт. под текущий фильтр</p>
          </div>
          {filterActive && (
            <div className="filter-summary">
              {category !== "all" && <span>категория: <strong>{categoryLabelRu(category)}</strong></span>}
              {tag !== "" && <span>тег: <strong>{humanizeTag(tag)}</strong></span>}
              {s !== "" && <span>поиск: <strong>{search.trim()}</strong></span>}
              <button className="filter-clear" onClick={clearFilters}>сбросить фильтры ✕</button>
            </div>
          )}
          <LazyFeed events={filteredEvents} today={payload.today} />
        </section>
      </main>
    </div>
  );
}

function FeedCard({ item, today }: { item: SiteEvent; today: string }) {
  const img = usableImageUrl(item.image_url);
  return (
    <article className={`feed-card${item.is_hemisferic ? " is-hemis" : ""}${item.feature && item.feature !== "hemisferic" ? " feature-" + item.feature : ""}`}>
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt="" />
      ) : (
        <div className="card-visual placeholder" />
      )}
      <div className="card-body">
        <h3>{item.title}</h3>
        <div className="card-meta">
          {item.is_exposition ? (
            <span className="expo-badge">{expositionBadge(item, today)}</span>
          ) : (
            <span>{item.date_label}</span>
          )}
          <span>{item.location_label}</span>
          {item.is_series && item.occurrence_count > 0 && (
            <span>{item.occurrence_count} {pluralSeans(item.occurrence_count)}</span>
          )}
          <span>score {item.score ?? "—"}</span>
        </div>
        <p>{item.excerpt || "Описание подтянем позже."}</p>
        <div className="tags-row">
          {item.tags.map((t) => (
            <span key={t} className="tag">{humanizeTag(t)}</span>
          ))}
        </div>
        <div className="card-actions">
          <Link className="card-link" href={item.page_url}>Открыть карточку →</Link>
          {(item.source_url || item.url) && (
            <a className="card-link" href={item.source_url || item.url || "#"} target="_blank" rel="noreferrer">Источник ↗</a>
          )}
        </div>
      </div>
    </article>
  );
}

// Tag cloud (T163): frequency-weighted tag chips. Font-size + weight scale with each
// tag's relative frequency (most-frequent = biggest/boldest). Clicking a chip toggles
// the feed filter to that tag; clicking the active chip clears it back to "all".
function TagCloud({
  tags,
  active,
  onSelect,
}: {
  tags: { tag: string; count: number }[];
  active: string;
  onSelect: (t: string) => void;
}) {
  if (tags.length === 0) return null;
  const counts = tags.map((t) => t.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const sizeFor = (count: number) => {
    // Map count → [0.82rem, 1.5rem] linearly (flat 1.05rem when all counts are equal).
    if (max === min) return 1.05;
    const t = (count - min) / (max - min);
    return 0.82 + t * (1.5 - 0.82);
  };
  return (
    <div className="tag-cloud">
      {tags.map(({ tag, count }) => {
        const isActive = active === tag;
        return (
          <button
            key={tag}
            className={`tag-cloud-chip${isActive ? " is-active" : ""}`}
            style={{ fontSize: `${sizeFor(count).toFixed(2)}rem`, fontWeight: 500 + Math.round(((count - min) / Math.max(1, max - min)) * 350) }}
            onClick={() => onSelect(isActive ? "" : tag)}
            title={`${humanizeTag(tag)} · ${count}`}
          >
            {humanizeTag(tag)}
            <span className="tag-count">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

// Category filter bar (T163): one chip per distinct event category + an "все категории"
// reset. Clicking a category toggles the feed filter; combines with the tag cloud (AND).
function CategoryFilter({
  categories,
  active,
  onSelect,
}: {
  categories: { category: string; count: number }[];
  active: string;
  onSelect: (c: string) => void;
}) {
  return (
    <div className="category-bar">
      <button
        className={`category-chip${active === "all" ? " is-active" : ""}`}
        onClick={() => onSelect("all")}
      >
        все категории
      </button>
      {categories.map(({ category, count }) => (
        <button
          key={category}
          className={`category-chip${active === category ? " is-active" : ""}`}
          onClick={() => onSelect(active === category ? "all" : category)}
        >
          {categoryLabelRu(category)}
          <span className="cat-count">{count}</span>
        </button>
      ))}
    </div>
  );
}

// Lazy feed (T163): renders an initial FEED_BATCH cards and grows by FEED_BATCH each
// time an IntersectionObserver sentinel scrolls into view (or the "показать ещё" button
// is clicked). Pure presentation over the already-fetched, already-filtered list — no
// new API. The visible count resets whenever the filtered list changes (new filter).
function LazyFeed({ events, today }: { events: SiteEvent[]; today: string }) {
  const [visible, setVisible] = useState(FEED_BATCH);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reset the window when the filtered list identity changes (filter/search applied).
  useEffect(() => {
    setVisible(FEED_BATCH);
  }, [events]);

  const hasMore = visible < events.length;

  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible((v) => Math.min(v + FEED_BATCH, events.length));
        }
      },
      { rootMargin: "400px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, events.length]);

  if (events.length === 0) {
    return <p className="panel-note">Под текущий фильтр событий нет.</p>;
  }

  return (
    <>
      <div className="feed-list">
        {events.slice(0, visible).map((item) => (
          <FeedCard key={item.id} item={item} today={today} />
        ))}
      </div>
      {hasMore && (
        <>
          <div ref={sentinelRef} className="feed-more-sentinel" aria-hidden />
          <div className="feed-more">
            <button
              className="button"
              onClick={() => setVisible((v) => Math.min(v + FEED_BATCH, events.length))}
            >
              показать ещё ({events.length - visible})
            </button>
          </div>
        </>
      )}
    </>
  );
}

const MONTH_ABBR_RU = [
  "янв", "фев", "мар", "апр", "мая", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

// Feed badge for a standing exposition: "идёт до DD месяца" (RU month), or
// "постоянная экспозиция" when the end is far out (> ~1 year ahead).
function expositionBadge(item: SiteEvent, today: string): string {
  if (!item.end_date) return "постоянная экспозиция";
  const end = item.end_date.slice(0, 10);
  const todayDate = today.slice(0, 10);
  const yearsOut = (Date.parse(end) - Date.parse(todayDate)) / (365 * 86_400_000);
  if (yearsOut > 1) return "постоянная экспозиция";
  const [, m, d] = end.split("-");
  return `идёт до ${Number(d)} ${MONTH_ABBR_RU[Number(m) - 1]}`;
}

function Calendar({
  payload,
  monthIndex,
  setMonthIndex,
}: {
  payload: SitePayload;
  monthIndex: number;
  setMonthIndex: (fn: (i: number) => number) => void;
}) {
  const months = payload.months;
  const monthKey = months[monthIndex];

  // Standing expositions overlapping the visible month (T186). Each exhibition appears
  // ONCE (not per-week-segment). When 20+ exhibitions all span the whole month, spanning
  // bars degenerate into a full-width "wall" that conveys nothing and pushes the day grid
  // down the page — so we render a single compact collapsible strip of one-line entries
  // instead (mirrors the .day-hemis <details> pattern). Deterministic order: longest span
  // first (reads as the most "standing"), then start, then title.
  const expositions = useMemo<SiteEvent[]>(() => {
    if (!monthKey) return [];
    const [year, month] = monthKey.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStartMs = Date.UTC(year, month - 1, 1);
    const monthEndMs = Date.UTC(year, month - 1, daysInMonth);

    const expos = payload.events.filter(
      (e) =>
        e.is_exposition &&
        !e.calendar_only &&
        e.start_date &&
        e.end_date &&
        Date.parse(e.start_date.slice(0, 10)) <= monthEndMs &&
        Date.parse(e.end_date.slice(0, 10)) >= monthStartMs,
    );
    expos.sort((a, b) => {
      const la = Date.parse(a.end_date!.slice(0, 10)) - Date.parse(a.start_date!.slice(0, 10));
      const lb = Date.parse(b.end_date!.slice(0, 10)) - Date.parse(b.start_date!.slice(0, 10));
      if (la !== lb) return lb - la;
      const sa = a.start_date!.slice(0, 10);
      const sb = b.start_date!.slice(0, 10);
      if (sa !== sb) return sa.localeCompare(sb);
      return a.title.localeCompare(b.title);
    });
    return expos;
  }, [monthKey, payload.events]);

  const cells = useMemo(() => {
    if (!monthKey) return null;
    const [year, month] = monthKey.split("-").map(Number);
    const firstDay = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const offset = (firstDay.getDay() + 6) % 7; // Monday-first

    const byDate = new Map<number, SiteEvent[]>();
    for (const item of payload.events) {
      // Skip series feed cards (is_series): they have no single calendar date — their
      // sessions are placed individually via the calendar-only occurrence rows below.
      if (item.is_series) continue;
      // Skip expositions: they render in the compact .expo-strip above the grid (T186),
      // NOT as a per-day card duplicated across every day of their range.
      if (item.is_exposition) continue;
      if (!(item.start_date || "").startsWith(monthKey)) continue;
      const day = Number((item.start_date || "").slice(-2));
      if (!byDate.has(day)) byDate.set(day, []);
      byDate.get(day)!.push(item);
    }
    const byTime = (a: SiteEvent, b: SiteEvent) =>
      (a.start_time || "99:99").localeCompare(b.start_time || "99:99");

    const out: React.ReactNode[] = [];
    for (let i = 0; i < offset; i++) out.push(<div key={`e${i}`} className="day-cell is-empty" />);
    for (let day = 1; day <= daysInMonth; day++) {
      const items = byDate.get(day) || [];
      const dayKey = `${monthKey}-${String(day).padStart(2, "0")}`;
      const isToday = dayKey === payload.today;
      const hemis = items.filter((x) => x.is_hemisferic).sort(byTime);
      const regular = items.filter((x) => !x.is_hemisferic).sort(byTime);
      out.push(
        <div key={day} className={`day-cell${isToday ? " is-today" : ""}`}>
          <div className="day-num">{day}</div>
          {regular.map((it) => (
            <Link key={it.id} className={`day-event${it.feature && it.feature !== "hemisferic" ? " feature-" + it.feature : ""}`} href={it.page_url}>
              {it.start_time && <span className="ev-time">{it.start_time}</span>}
              {it.title}
            </Link>
          ))}
          {hemis.length > 0 && (
            <details className="day-hemis">
              <summary>Hemisfèric · {hemis.length} {pluralSeans(hemis.length)}</summary>
              {hemis.map((it) => (
                <Link key={it.id} className="hemis-session" href={it.page_url}>
                  {it.start_time && <span className="ev-time">{it.start_time}</span>}
                  {it.title}
                </Link>
              ))}
            </details>
          )}
        </div>,
      );
    }
    return out;
  }, [monthKey, payload.events, payload.today]);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">календарь</p>
          <h2>События по датам</h2>
        </div>
        <div className="calendar-nav">
          <button className="mini-button" onClick={() => setMonthIndex((i) => (i - 1 + months.length) % months.length)}>←</button>
          <strong>{monthKey ? `${MONTH_NAMES[Number(monthKey.split("-")[1]) - 1]} ${monthKey.split("-")[0]}` : "—"}</strong>
          <button className="mini-button" onClick={() => setMonthIndex((i) => (i + 1) % months.length)}>→</button>
        </div>
      </div>
      <p className="legend">
        <span className="legend-dot legend-event" /> события
        <span className="legend-dot legend-hemis" /> Hemisfèric
        <span className="legend-dot legend-feria" /> фестивали / спец
        <span className="legend-dot legend-excursion" /> экскурсии
        <span className="legend-dot legend-exposition" /> экспозиции (идут постоянно)
      </p>
      {expositions.length > 0 && (
        <details className="expo-strip">
          <summary>Экспозиции · {expositions.length} (идут постоянно)</summary>
          <div className="expo-strip-list">
            {expositions.map((e) => (
              <Link key={e.id} className="expo-strip-item" href={e.page_url} title={e.title}>
                <span className="expo-strip-title">{e.title}</span>
                <span className="expo-badge">{expositionBadge(e, payload.today)}</span>
              </Link>
            ))}
          </div>
        </details>
      )}
      <div className="calendar-grid">
        {cells || <div className="day-cell">Пока нет датированных событий.</div>}
      </div>
    </section>
  );
}

function MapPanel({
  events,
  places,
  center,
}: {
  events: SiteEvent[];
  places: SitePlace[];
  center: { lat: number; lng: number };
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapped = places.filter((p) => p.lat != null && p.lng != null);

  useEffect(() => {
    let map: any;
    let cancelled = false;

    async function ensureLeaflet(): Promise<any> {
      if ((window as any).L) return (window as any).L;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
        script.integrity = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
        script.crossOrigin = "";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("leaflet failed"));
        document.body.appendChild(script);
      });
      return (window as any).L;
    }

    ensureLeaflet().then((L) => {
      if (cancelled || !mapRef.current) return;
      map = L.map(mapRef.current).setView([center.lat, center.lng], 11);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      for (const p of places) {
        if (p.lat == null || p.lng == null) continue;
        L.marker([p.lat, p.lng]).addTo(map).bindPopup(placePopupHtml(p));
      }
      for (const e of events) {
        if (e.lat == null || e.lng == null) continue;
        L.circleMarker([e.lat, e.lng], {
          radius: 7, color: "#00a296", fillColor: "#00a296", fillOpacity: 0.9,
        }).addTo(map).bindPopup(eventPopupHtml(e));
      }
    });

    return () => {
      cancelled = true;
      if (map) map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="panel panel-map">
      <div className="panel-head">
        <div>
          <p className="eyebrow">карта</p>
          <h2>Места и локации</h2>
          <Link className="card-link" href="/places">Открыть каталог всех мест →</Link>
        </div>
        <p className="panel-note">
          {mapped.length} мест с координатами, {places.length - mapped.length} пока без pin
        </p>
      </div>
      <div ref={mapRef} className="map-frame" />
      <div className="places-list">
        {places.map((item) => {
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
    </section>
  );
}
