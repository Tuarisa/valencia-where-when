# Инструкция: залить в GitHub, поднять БД и задеплоить на Vercel

Команды можно вбивать по порядку. Всё запускается из папки проекта.

```bash
cd ~/Documents/Claude/Projects/Valencia-where-when
```

---

## 1. Залить проект в GitHub (репозиторий уже создан: `Tuarisa/valencia-where-when`)

Я уже сделал первый коммит локально. Осталось привязать remote и запушить:

```bash
git remote add origin https://github.com/Tuarisa/valencia-where-when.git
git branch -M main
git push -u origin main
```

> Если попросит логин — вбей GitHub-username и **Personal Access Token** вместо пароля
> (Settings → Developer settings → Tokens). Или, если стоит GitHub CLI: `gh auth login`.

---

## 2. Создать базу Neon Postgres

Самый простой путь — через Vercel (он сам подключит переменные):

1. Зайди на <https://vercel.com> → твой проект → вкладка **Storage** → **Create Database** → **Postgres (Neon)**.
2. Vercel автоматически добавит `DATABASE_URL` (и связанные) в Environment Variables.

Либо отдельно на <https://neon.tech>: создай проект, скопируй **pooled connection string**
(вида `postgresql://user:pass@...neon.tech/db?sslmode=require`).

Положи строку локально, чтобы прогнать миграцию:

```bash
echo 'DATABASE_URL="ВСТАВЬ_СЮДА_СТРОКУ_NEON"' > .env.local
echo 'CRON_SECRET="'"$(openssl rand -hex 24)"'"' >> .env.local
```

---

## 3. Создать таблицы и залить данные прототипа (342 события и т.д.)

```bash
npm install
set -a && source .env.local && set +a   # подхватить DATABASE_URL в текущую сессию
npm run db:setup                          # = apply-schema + seed
```

Ожидаемый вывод: `{"ok": true, "statements": …}` и
`{"ok": true, "inserted": {"sources": 22, "events": 342, "places": 14, "media_assets": 216}}`.

---

## 4. Задеплоить на Vercel

```bash
npm i -g vercel        # если ещё не стоит
vercel login
vercel link            # привязать к проекту (или создать новый из этого репо)
vercel --prod
```

В настройках проекта на Vercel (Settings → Environment Variables) должны быть:

| Переменная | Значение |
|---|---|
| `DATABASE_URL` | строка Neon (шаг 2; если делал через Storage — уже там) |
| `CRON_SECRET` | то же значение, что в `.env.local` (шаг 2) |

После добавления переменных — передеплой: `vercel --prod`.

> Альтернатива без CLI: на vercel.com → **Add New → Project → Import** репозиторий
> `Tuarisa/valencia-where-when`. Framework определится как Next.js автоматически.

---

## 5. Проверить, что живёт

- Открой выданный Vercel URL — должна быть лента + календарь + карта с данными.
- Дёрни пайплайн вручную (подтянет свежие события):

```bash
curl -H "Authorization: Bearer ТВОЙ_CRON_SECRET" https://ТВОЙ-URL.vercel.app/api/cron/refresh
```

Cron уже прописан в `vercel.json` — раз в сутки в 07:15 UTC. На плане Hobby Vercel
разрешает крон **раз в день**; на Pro можно вернуть каждые 12 часов
(`"schedule": "15 7,19 * * *"`).

---

## Локальная разработка (по желанию)

```bash
set -a && source .env.local && set +a
npm run dev          # http://localhost:3000
```

Прогнать пайплайн локально: `npm i -D tsx && npm run pipeline:run`.
