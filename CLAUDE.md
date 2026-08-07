<!-- SPECKIT START -->
# Valencia Radar — agent context

**Что это:** русскоязычная афиша Валенсии — лента + календарь + карта + каталог мест.
**PROD (запущен 2026-07-05): https://valencia-where-when.vercel.app** — Vercel Hobby
(git auto-deploy из `main`) + Neon free tier. Прод **AI-less** (решение T162): ни ключей,
ни `claude -p` на сервере; тяжёлый AI — только локально.

**Spec-система**: активная фича `001-valencia-radar` (резолвится через `.specify/feature.json`);
`specs/001-valencia-radar/{spec,plan,tasks,research,data-model}.md`; конституция
`.specify/memory/constitution.md` (v1.1.0). **Бэклог и вся хроника решений = `tasks.md`**
(T-номера; сейчас ~T198). История изменений — в git log (говорящие сообщения коммитов);
прежняя (огромная) версия этого файла — в git-истории до 2026-08-07.

## Стек и архитектура
Next.js 14 App Router + React 18 · Neon serverless Postgres (`@neondatabase/serverless`,
**обязательно `fetchOptions.cache:'no-store'`** — см. уроки ниже) · пайплайн TypeScript в
`lib/pipeline/`: **ingest → normalize (реестр ~20 нормализаторов) → dedup → score → tag →
[enrich] → geo**. Подробно: `ARCHITECTURE.md` (человекочитаемая схема), `DEPLOY.md`
(runbook + принятые решения), `specs/001-valencia-radar/cost-estimate.md` (экономика).

- **Local-first (T144)**: тяжёлое (AI-обогащение, гео, полный dedup) гоняется ЛОКАЛЬНО на
  подписке → запекается в `data/seed/*.json` → прод стартует с готовым контентом.
- **Прод-цикл (T198)**: GH-Actions `*/15` + Vercel daily крон → `/api/cron/dispatch`
  (GET и POST) — адаптивный ингест ТОЛЬКО созревших источников (cadence, conditional-GET)
  **+ материализация за тик**: normalize только-что-ингестированных источников → dedup →
  score/tag, всё fail-soft под ~45с бюджетом (60с Hobby-лимит). Geo/enrich в тике НЕТ
  (Nominatim медленный / AI-less). Новые события на проде появляются сами, но
  НЕпереведёнными — русскими их делает локальный ритуал.
- **Сид** (`data/seed/`): `events.json` (только будущие derived, 0 null-дат) +
  **нативные `event_series.json`/`event_occurrences.json`** (Hemisfèric и др.) + curated
  `events-*.json` (feria/fever/logunespa/ads) + places/sources. Пекётся ТОЛЬКО через
  `scripts/rebake-seed.mjs` (схемо-управляемые колонки; guards: 0 null-дат, ≥1 серия,
  без прошедших, без api:hemisferic в events.json).
- **Enrich-движок**: `claude -p` (подписка, БЕЗ ключа) — `lib/pipeline/enrich-client.ts`;
  модельные **алиасы** `haiku` (перевод) / `sonnet` (grounded WebFetch — обязателен
  `--allowedTools WebFetch`) — алиасы сами резолвятся в новейшие модели, датированных
  пинов в коде нет. enrich.ts движко-независим (инъектируемый клиент; SDK-клиент = путь
  апгрейда за ~$3–6/мес, см. cost-estimate.md).

## ПРАВИЛА (user, REQUIRED — не нарушать)
- **Локальная БД живёт вечно**: Docker Postgres `main` (`db.localtest.me`) накапливает
  реальные данные и НИКОГДА не убивается между циклами (`db:local:down` — нельзя;
  `CREATE DATABASE … TEMPLATE main` — нельзя, роняет сервер; для проверок — пустая
  throwaway-БД + `db:setup`, потом DROP).
- **Ultracode-цикл**: проект живёт через `/loop /speckit-implement`; основная петля
  ДЕЛЕГИРУЕТ содержательную работу сабагентам/Workflow, сама только выбирает задачу,
  интегрирует, гоняет гейт и коммитит+пушит. Контекст петли держать тощим. Билды НЕ
  параллелить (ломается `.next`); гейт `npm run build && npm test` зелёный перед коммитом.
- **`backlog:`/`бэклог:`-сообщения** — немедленно записать в «Backlog — user inbox» в
  `tasks.md` (record-only, текущую работу не бросать).
- **«JS прежде LLM» (T140)**: правила/ключевые слова — детерминированный JS; haiku только
  на перевод, sonnet только на grounding. Даты не выдумывать (нет даты → не эмитить).
- **Перезапись `data/seed/`** — только с подтверждением пользователя (рутинный ре-бейк в
  рамках ритуала обновления пользователь одобряет словом «перепеки» / «обновим»).
- Конституция: append-only сырьё; dedup хранит ссылку на каждый источник
  (entity_sources) и не сливает по fallback-гео; схема — только аддитивно; сайт
  рендерится детерминированно из БД.

## Ключевые команды и ритуалы
- Гейт: `npm run build` + `npm test` (`node --import tsx --test`).
- Локальный стек: `npm run db:local:up` → `dev:local`; сид грузится `npm run db:setup`.
- **Ритуал обновления (T195, раз в несколько дней / по слову «обновим события»)** —
  локально фоновым шеллом (~1–1.5ч): `ingestAll()` → `normalizeAll()` → `dedup()` →
  `scoreAll()`/`tagAll()` → `geoEnrich(N)` → `enrichCards(N, {client:
  createClaudeEnrichClient()})` → `node --import tsx scripts/rebake-seed.mjs --commit` →
  гейт → commit+push (сайт автодеплоится) → `DATABASE_URL=<neon> npm run db:setup`
  (идемпотентно, обновляет прод-БД).
- Прод-доступы: Vercel team `tuarisas-projects`, проект `valencia-where-when` (MCP
  подключён); Neon URL и `CRON_SECRET` — в env Vercel + GH-secrets (в репо НЕ хранить);
  `gh` авторизован (Tuarisa). Здоровье: `/api/health` (info-warnings не валят ok) и
  `APP_BASE_URL=<url> npm run smoke`.

## Уроки, оплаченные кровью (не наступать снова)
- **Neon + Next Data Cache**: драйвер ходит через `fetch()`, Vercel кэширует ЕГО ответы
  между запросами и деплоями → любое чтение БД замерзает. Лечится только
  `neon(url, {fetchOptions:{cache:'no-store'}})` в `lib/db.ts` (уже стоит — не убирать).
- **Serverless-бандл не берёт файлы с диска** — активы (сертификаты) инлайнить в код
  (`lib/pipeline/cac-intermediate-ca.ts`; cac.es шлёт неполную TLS-цепочку, проверка
  остаётся ВКЛЮЧЁННОЙ). **Vercel Cron шлёт GET** — крон-роуты должны принимать GET.
  **`maxDuration > 60` валит Hobby-деплой.**
- Тестовые «зеркала» функций (`parseEventDate` и т.п. скопированы в тесты) держать
  байт-в-байт с оригиналом при правках.
- В `-p`-режиме WebFetch заблокирован без `--allowedTools WebFetch`.
- Данные врут красиво: у агрегаторов слаги городов транслитом (valensiya), даты в
  заголовках («Del al 28 jun»), цены в тегах — нормализаторы чинить об РЕАЛЬНЫЕ строки
  из живой БД, не о синтетику.

## Открытые направления (детали в tasks.md)
Дизайн — 2-я итерация после отзыва пользователя (T194 сделан консервативно: убрана
«полоска слева», плоше/плотнее под dalnoboi.org — сайт и вкус пользователя);
Telegram-дайджест (транспорт пока dry-run); T160 (цены, ждёт полного ре-бейка);
заблокированное на Workflow SDK (T021/T022/T055 — `workflow@4.5.0` не билдится с
next@14.2.15 локально); исторический краул logunespa стоит на ~посте 833 (возобновлять
только по слову пользователя).

**Память** (`~/.claude/projects/...-Valencia-where-when/memory/`): prod-live,
local-first-baking, content-policy, model-tiering, prefer-js-over-llm — актуальны;
MEMORY.md — индекс.
<!-- SPECKIT END -->
