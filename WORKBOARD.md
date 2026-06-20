# Workboard

## Done (этот заход — миграция на Node.js)
- [x] Схема SQLite → Postgres (`db/schema.sql`), все таблицы и индексы
- [x] Перенос данных прототипа в seed: 342 события, 14 мест, 216 media, 22 источника
- [x] `lib/db.ts` (Neon) + хэши дедупа (`util.ts`) 1:1 с `db.py`
- [x] Ingest: telegram `t.me/s/`, Hemisfèric API, generic web (`lib/pipeline/ingest.ts`)
- [x] Score 1:1 (`lib/pipeline/score.ts`), Tags 1:1 (`lib/pipeline/tags.ts`), Geo (`geo.ts`)
- [x] Normalize: детерминированный Hemisfèric (`normalize.ts`)
- [x] Сайт: лента + календарь (группировка Hemisfèric, время, цвет) + Leaflet-карта
- [x] Страницы событий/мест с источником, тегами, rich-text, картинкой
- [x] Vercel Cron `/api/cron/refresh`, защита `CRON_SECRET`
- [x] Скрипты: apply-schema, seed, run-pipeline
- [x] Build Next.js компилируется, типы валидны

## Next (бэклог, перенесён из прототипа)
- [ ] **Полный нормализатор** прочих источников (порт `normalize_sources.py`, 979 строк):
      worldafisha, valenciarusa, vidacultural, concerten, Palau, CAC, visitvalencia, lacotorra.
      Сейчас их raw копится в `source_items` (status `pending`); историческая база уже наполнена.
- [ ] **Fever-экстрактор** (`fetch_fever.py`) — индивидуальные страницы, дрон-шоу / Harry Potter.
- [ ] **enrich_cards** через `claude -p`: OCR афиш, `title_ru` / `description_ru`, кликабельные ссылки.
- [ ] **Дедуп между источниками** для событий (как Слава Комиссаренко: 3 записи → 1, гасить
      ошибочные даты телеграм-постов, брать запись с большим score).
- [ ] **Notify-слой**: Telegram-бот или email-дайджест (еженедельно, пятница; фильтр RU +
      семейные фестивали/шоу). Сейчас «website only».
- [ ] Геокодинг событий: подтянуть больше координат (сейчас 34/342 событий с гео).
- [ ] Ticketmaster / Songkick / Valencia Bonita / Hoy Valencia — экстракторы.

## Заметки
- На Vercel Hobby крон — раз в сутки. Для каждые-12ч нужен Pro (`"15 7,19 * * *"`).
- Nominatim требует паузу между запросами (в `geo.ts` стоит 1.1s) и нормальный User-Agent.
