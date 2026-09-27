# mail-triage

Сервис разбора почты для голосового ассистента (Волны). Сам забирает новую почту из Gmail, размечает каждое письмо через Jev (категория, нужно ли действие, срочность) и отдаёт это по MCP короткими, удобными для речи ответами.

## Как устроено

- `src/sync.ts` — фоновая синхронизация через историю Gmail: только новые письма и изменения меток. Каждые `SYNC_INTERVAL_MIN` минут.
- `src/triage.ts` — разметка письма. Известный рекламный отправитель размечается без модели. Для остальных — вызов Jev (`typesafe/jev-1.13` через OpenRouter): категория, `needs_action`, `urgency`.
- `src/digest.ts` — чтение: сводка по группам (`action`, `notable`, `other`), списки с фильтрами, текст письма.
- `src/mcp.ts`, `src/server.ts` — MCP по Streamable HTTP без сессий, `POST /mcp`, Bearer-токен. `GET /health`.
- `src/db.ts` — SQLite (`node:sqlite`), всё разделено по ящикам.
- `src/cli.ts` — настройка владельцем: подключить ящик, импорт, синхронизация, повторная разметка.
- `src/cleanup/` — разовая чистка ящика (выгрузка, разметка отправителей, план, архив и отписка).

Инструменты MCP (все только чтение, `readOnlyHint`): `digest`, `list`, `read`, `accounts`, `sync`. Имена без префикса: клиент добавляет свой (в Волне — `mail_digest`).

## Установка

Нужен Node ≥ 22.18 (запуск TypeScript без сборки).

```sh
pnpm install
cp .env.example .env            # OPENROUTER_API_KEY, MAIL_TRIAGE_TOKEN
# credentials.json — OAuth-клиент Google типа Desktop с Gmail API
node --env-file=.env src/cli.ts accounts add     # вход в Google в браузере
node --env-file=.env src/cli.ts sync             # первые 14 дней входящих
pnpm start                                        # MCP на http://127.0.0.1:8790/mcp
```

Автозапуск на Mac: `deploy/com.sketchpiece.mail-triage.plist` (инструкция внутри).

Приложение Google в режиме Testing выдаёт токен на 7 дней. Для постоянной работы переведи его в Production (Google Auth Platform → Audience → Publish app); проверка Google для личного использования не нужна.

## Подключение к Волне

Плагин лежит в `volna-plugin/mail`: `plugin.json`, `.mcp.json` (HTTP + Bearer) и техкарта «Почта» с пробными фразами маршрута.

```sh
# в server/.env Волны:
MAIL_TRIAGE_TOKEN=<тот же токен>
# MAIL_TRIAGE_URL=http://127.0.0.1:8790/mcp   (по умолчанию)

cd ~/Documents/Projects/Volna/server
npm run plugins -- add ~/Documents/Sandbox/mail-triage/volna-plugin/mail
npm run plugins -- enable mail
npm run plugins -- check mail
npm run skills -- check mail
# перезапустить мост
```

Проверено с клиентом моста (`server/src/plugins/mcp-client.ts`): без токена 401, инструменты приходят с эффектом `read`, `digest` отвечает за миллисекунды и укладывается в ~1 000 знаков.
