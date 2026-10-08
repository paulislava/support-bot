# @paulislava/support-bot

Открытый сервер поддержки для нескольких сервисов. Обращения из приложения и email объединяются в постоянную тему Telegram на пару `service + userId`. История хранится в PostgreSQL. Под каждым обращением есть кнопка **Info** с данными, которые передал сервис. Бот отвечает в тот же канал, из которого пришло последнее обращение пользователя.

## Запуск

Node.js 22+, PostgreSQL 16+. Скопируйте `.env.example` в закрытое окружение, задайте реальные значения, затем:

```sh
npm ci
npm run build
npm start
```

Сервер слушает `127.0.0.1:8787`; публикуйте его через HTTPS reverse proxy. Telegram webhook укажите на `/v1/telegram/webhook` и задайте `secret_token`, равный `TELEGRAM_WEBHOOK_SECRET`. Для тем нужен Telegram-чат с доступной функцией `createForumTopic` (включая личный чат с включёнными темами). ID владельца укажите в `TELEGRAM_ADMIN_CHAT_ID`.

## API

Вызовы приложения выполняет backend сервиса, который уже авторизовал пользователя. Ключ сервиса из `SERVICE_KEYS_JSON` передаётся в `Authorization: Bearer ...`. Не помещайте его в мобильный клиент.

- `POST /v1/messages`: JSON `{ "service":"PaulIsLavaTV", "userId":"account-uuid", "text":"Помогите", "requestId":"uuid", "name":"Павел", "email":"user@example.com", "info":{"ТВ":"Sony"}, "webhookUrl":"https://tv.paulislava.space/api/support/reply" }`.
- `GET /v1/messages?service=PaulIsLavaTV&userId=account-uuid&before=message-uuid`: история до 100 сообщений; `before` необязателен.
- `POST /v1/email/inbound`: нормализованный email webhook с заголовком `X-Support-Email-Secret`; JSON `{ "service":"...", "from":"user@example.com", "subject":"...", "text":"...", "id":"uuid" }`. Шлюз входящей почты должен проверять подпись своего провайдера и присылать сюда только доверенные письма. Ответ оператора доставляется через SMTP.
- `POST /v1/telegram/webhook`: Telegram webhook с заголовком `X-Telegram-Bot-Api-Secret-Token`.
- `GET /health`: liveness.

В `info` можно передать данные аккаунта, коробок и ТВ; только backend исходного сервиса решает, какие поля раскрывать оператору. Для каждого продукта нужен отдельный ключ. Токены и данные пользователей нельзя добавлять в репозиторий.

Для ответов в приложение сервис сохраняет `webhookUrl` последнего обращения. Origin URL должен точно совпадать с `SERVICE_WEBHOOK_ORIGINS_JSON` для продукта. При ответе оператора туда уходит POST с `id`, `service`, `userId`, `threadId`, `channel`, `text`, `telegramMessageId`. Заголовок `X-Support-Signature` содержит `sha256=<hex HMAC-SHA256>` от строки `<X-Support-Timestamp>.<raw JSON body>` с ключом продукта. Принимающая сторона проверяет подпись и свежесть timestamp, а `id` использует для идемпотентности. При ошибке webhook Telegram повторит update.

Пакет экспортирует `SupportClient` для отправки и чтения истории, а также `verifyReplyWebhook` для принимающего backend. Пример:

```ts
import { SupportClient, verifyReplyWebhook } from '@paulislava/support-bot';

const client = new SupportClient('https://support.example.com', 'PaulIsLavaTV', process.env.SUPPORT_SERVICE_KEY!);
await client.send({ userId: account.id, text: 'Помогите', webhookUrl: 'https://tv.paulislava.space/api/support/reply', info: { tv: 'Sony' } });

// В обработчике webhook считайте исходные байты запроса как UTF-8 строку.
const reply = verifyReplyWebhook(rawBody, request.headers['x-support-timestamp'], request.headers['x-support-signature'], process.env.SUPPORT_SERVICE_KEY!);
// Сохраните reply.id с UNIQUE ограничением, затем добавьте сообщение в историю и отправьте push.
```

## Текущее ограничение

Версия 0.1.0 обрабатывает текстовые обращения и ответы. Медиа, APNs-уведомления и миграция существующей истории PaulIsLavaTV ещё остаются в текущем backend ТВ; перенос этих частей нужен до переключения production-трафика на отдельный сервис.
