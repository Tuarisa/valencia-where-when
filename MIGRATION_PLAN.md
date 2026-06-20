# Valencia Radar — план миграции Python → Node.js + Vercel

Прототип (`~/.openclaw/workspace/projects/valencia-events`, Python + SQLite + статический
генератор) переписан на **Next.js 14 (TypeScript) + Neon Postgres**, разворачивается на
**Vercel**, обновляется через **Vercel Cron**. Данные прототипа (342 события, 14 мест,
216 картинок, 22 источника) перенесены 1:1.

## Что во что превратилось

| Python (прототип) | Node.js (этот репозиторий) | Назначение |
|---|---|---|
| `schema.sql` (SQLite) | `db/schema.sql` (Postgres) | Та же схема: sources, source_runs, source_items, events, places, media_assets, notifications |
| `db.py` (connect, hashing, upsert) | `lib/db.ts` + `lib/pipeline/util.ts` | Клиент Neon, sha1-хэши дедупа (`event_hash`, `source_item_hash`), `norm()` |
| `ingest_sources.py` | `lib/pipeline/ingest.ts` | Забор всех источников → `source_items` (telegram `t.me/s/`, Hemisfèric API, generic web), дедуп |
| `normalize_sources.py` | `lib/pipeline/normalize.ts` | Нормализация в `events`/`places` (пока детерминированный Hemisfèric; остальное — см. бэклог) |
| `score_events.py` | `lib/pipeline/score.ts` | Скоринг 0–100 (вес источника, язык, категория, город, горизонт дат, ключевые слова) — портирован 1:1 |
| `entity_tags.py` / `tag_entities.py` | `lib/pipeline/tags.ts` | Теги событий и мест по эвристикам — портировано 1:1 |
| `geo_enrich.py` | `lib/pipeline/geo.ts` | Резолв `maps.app.goo.gl`, парс координат, геокодинг через Nominatim |
| `build_site.py` (генератор статики) | `app/` (Next.js) | Лента + календарь + карта + страницы карточек, читает из Postgres вживую |
| `site/assets/styles.css` | `app/globals.css` | Те же стили (paper/accent/Hemisfèric-фиолетовый) |
| `site/assets/app.js` | `app/Home.tsx` | Поиск, теги, календарь с группировкой Hemisfèric, Leaflet-карта |
| cron (openclaw) | `vercel.json` + `app/api/cron/refresh` | Расписание пайплайна на Vercel |
| `notify_events.py` | — (бэклог) | Доставка дайджеста (пока «website only») |

## Архитектура

```
Vercel Cron (ежедневно)
   └─► GET /api/cron/refresh  ──► runPipeline()
          ingest → normalize → score → tag → geo   ──►  Neon Postgres
                                                            ▲
Браузер ─► Next.js (app/) ──── читает события/места ────────┘
```

- **БД**: Neon Postgres (serverless, HTTP-драйвер `@neondatabase/serverless`) — работает на
  Vercel без пула соединений. SQLite не годится: на Vercel файловая система эфемерна.
- **Сайт**: серверные компоненты (`force-dynamic`) читают свежие данные при каждом запросе.
- **Карта/календарь**: клиентский компонент `Home.tsx`, Leaflet с CDN.

## Перенос данных

`data/seed/*.json` — выгрузка из `valencia.db` (events/places/media_assets/sources).
`npm run db:seed` заливает их в Neon с сохранением id. Ключи JSON покрывают 100% колонок
схемы (проверено). Дальше база живёт сама — пайплайн добавляет новое.

## Что осталось (осознанно, следующий заход)

1. **Полный нормализатор** остальных источников (`normalize_sources.py` — 979 строк
   source-specific эвристик). Сейчас вживую нормализуется Hemisfèric; для прочих база уже
   наполнена перенесёнными данными, а свежий raw копится в `source_items` со статусом `pending`.
2. **Fever-экстрактор** (`fetch_fever.py`) — индивидуальные страницы (дрон-шоу).
3. **enrich_cards** (`claude -p`: OCR афиш, `title_ru`/`description_ru`).
4. **Notify-слой** — Telegram-бот / email-дайджест.

Подробности и статус — в `WORKBOARD.md`.
