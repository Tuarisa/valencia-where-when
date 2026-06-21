"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SitePayload, SiteEvent, SitePlace } from "@/lib/queries";
import { humanizeTag } from "@/lib/format";

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
  const [tag, setTag] = useState("all");
  const [monthIndex, setMonthIndex] = useState(() =>
    Math.max(0, payload.months.indexOf(payload.default_month || "")),
  );

  const s = search.trim().toLowerCase();
  const matchesTag = (tags: string[]) => tag === "all" || tags.includes(tag);

  // The FEED shows ordinary events + ONE card per series; calendar-only occurrence
  // rows (sub-area D, T043) are bucketed onto the calendar, never listed as feed cards.
  const filteredEvents = useMemo(
    () => payload.events.filter((e) => !e.calendar_only && matchesSearch(e, s) && matchesTag(e.tags)),
    [payload.events, s, tag],
  );
  const filteredPlaces = useMemo(
    () => payload.places.filter((p) => matchesSearch(p, s) && matchesTag(p.tags)),
    [payload.places, s, tag],
  );

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
        <div className="tag-strip">
          {["all", ...payload.top_tags].map((t) => (
            <button
              key={t}
              className={`tag-button ${t === tag ? "is-active" : ""}`}
              onClick={() => setTag(t)}
            >
              {t === "all" ? "всё" : humanizeTag(t)}
            </button>
          ))}
        </div>
      </section>

      <main className="layout">
        <div className="top-row">
          <Calendar
            payload={payload}
            monthIndex={monthIndex}
            setMonthIndex={setMonthIndex}
          />
          <MapPanel events={payload.events.filter((e) => !e.calendar_only)} places={filteredPlaces} center={payload.map_center} />
        </div>

        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">лента</p>
              <h2>Отфильтрованные события</h2>
            </div>
            <p className="panel-note">{filteredEvents.length} шт. под текущий фильтр</p>
          </div>
          <div className="feed-list">
            {filteredEvents.map((item) => (
              <FeedCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function FeedCard({ item }: { item: SiteEvent }) {
  return (
    <article className={`feed-card${item.is_hemisferic ? " is-hemis" : ""}${item.feature && item.feature !== "hemisferic" ? " feature-" + item.feature : ""}`}>
      {item.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.image_url} alt="" />
      ) : (
        <div className="card-visual placeholder" />
      )}
      <div className="card-body">
        <h3>{item.title}</h3>
        <div className="card-meta">
          <span>{item.date_label}</span>
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
      </p>
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
          radius: 7, color: "#d65a31", fillColor: "#d65a31", fillOpacity: 0.9,
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
        {places.map((item) => (
          <article key={item.id} className="place-card">
            {item.image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.image_url} alt="" />
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
        ))}
      </div>
    </section>
  );
}
