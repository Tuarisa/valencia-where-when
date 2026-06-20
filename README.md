# Valencia Radar

Афиша, места и (скоро) нотификации по Валенсии и округе: русскоязычные события
(стендап, концерты, встречи), городские фестивали, шоу и семейные движухи. Один каталог —
лента, теги, календарь и карта.

Node.js-переписка Python-прототипа. Стек: **Next.js 14 (TypeScript) · Neon Postgres · Vercel**.

## Структура

```
app/                    Next.js (App Router)
  page.tsx              главная: лента + календарь + карта (server component)
  Home.tsx              интерактив: поиск, теги, календарь, Leaflet-карта (client)
  events/[id]/page.tsx  страница события
  places/[id]/page.tsx  страница места
  api/cron/refresh/     эндпоинт пайплайна (дёргается Vercel Cron)
  globals.css           стили (портированы из прототипа)
lib/
  db.ts                 клиент Neon
  format.ts             deriveTitle / даты / слаги / теги
  queries.ts            чтение событий/мест, сборка payload
  pipeline/             ingest · normalize · score · tags · geo · run
db/schema.sql           схема Postgres
data/seed/*.json        данные прототипа (events/places/media/sources)
scripts/                apply-schema · seed · run-pipeline
vercel.json             расписание крона
```

## Пайплайн

`ingest` (забор источников → `source_items`, дедуп) → `normalize` (→ `events`/`places`)
→ `score` (0–100) → `tags` → `geo` (геокодинг). Запускается последовательно из
`lib/pipeline/run.ts`, по расписанию через `/api/cron/refresh`.

## Запуск

См. **[SETUP_INSTRUCTIONS.md](./SETUP_INSTRUCTIONS.md)** — GitHub, Neon, Vercel по шагам.
Архитектура и маппинг со старым кодом — **[MIGRATION_PLAN.md](./MIGRATION_PLAN.md)**.
Что доделать — **[WORKBOARD.md](./WORKBOARD.md)**.

Кратко локально:

```bash
npm install
echo 'DATABASE_URL="postgres://…neon…"' > .env.local
set -a && source .env.local && set +a
npm run db:setup     # схема + данные прототипа
npm run dev          # http://localhost:3000
```
