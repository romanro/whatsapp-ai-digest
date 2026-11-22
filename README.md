# WhatsApp AI Digest

On-demand, **read-only** Chrome extension + local server that turns the messages of the currently open WhatsApp Web
**group** into a short structured summary **in Russian**: announcements, dates & events, tasks, payments, plan changes
and other important information — each item with the original message timestamps.

```
Chrome popup (React) ──► content script (reads visible messages of the open group, on click only)
        │
        └─ redacted, user-confirmed JSON ──► local Fastify server 127.0.0.1:3741 ──► Groq API (OpenAI-compatible)
```

> ⚠️ **Status of the WhatsApp integration:** the DOM selectors in
> [`apps/extension/src/content/selectors.ts`](apps/extension/src/content/selectors.ts) are based on the publicly known
> WhatsApp Web structure and are covered by tests against a *synthetic* DOM. They have **not** been verified against the
> live WhatsApp Web UI by the author. Follow [Manual testing](#manual-testing-of-the-whatsapp-integration) before relying on it.

## Установка на Windows (по-русски)

Нужны только Windows 10/11 и Google Chrome. Node.js, pnpm и Git не нужны: всё необходимое внутри установщика.

**1. Получи ключ Groq.** Зайди на <https://console.groq.com/keys>, войди (можно через Google) и нажми
**Create API Key**. Скопируй ключ: он начинается с `gsk_`.

**2. Скачай и запусти установщик:**
[WhatsAppAIDigestSetup.exe](https://github.com/romanro/whatsapp-ai-digest/releases/latest/download/WhatsAppAIDigestSetup.exe).

- Установщик не подписан, поэтому Windows может показать «Windows защитил ваш компьютер». Нажми **Подробнее** →
  **Выполнить в любом случае**.
- Права администратора не нужны: программа ставится только для текущего пользователя.
- На шаге **«Ключ Groq»** вставь ключ. Можно пропустить и добавить позже: меню значка в трее → «Настройки сервера (.env)».
- Оставь галочку «Запускать при входе в Windows», чтобы сервер стартовал сам.

**3. Подключи расширение в Chrome (один раз).** В конце установки откроются страница `chrome://extensions` и папка
расширения.

1. Включи **«Режим разработчика»** (переключатель справа сверху).
2. Нажми **«Загрузить распакованное расширение»** и выбери папку
   `%LOCALAPPDATA%\Programs\WhatsAppAIDigest\extension`. Её же открывает пункт «Папка расширения для Chrome…» в меню
   значка в трее.
3. Закрепи значок расширения через кнопку с пазлом.

Этот шаг нельзя автоматизировать: Chrome не даёт программам ставить расширения не из Chrome Web Store.

**4. Пользуйся.** Значок у часов: бирюзовый — всё готово, оранжевый — сервер запускается или нет ключа, серый — сервер
остановлен. Открой <https://web.whatsapp.com/>, зайди в группу, прокрути чат вверх на нужный период, потом обратно
вниз, и нажми значок расширения.

**Документы (PDF, DOCX).** Если в чате за период есть документы, экран проверки покажет их список. Расширение само файлы
не скачивает: нажми на документ в WhatsApp → «Скачать», затем «Добавить документы» (окно откроется во вкладке) и
перетащи туда скачанный файл. Он читается прямо в браузере; в Groq уходит его текст (телефоны, email и номера карт
скрываются), а для скана — первые 3 страницы как картинки. В сводке под источником будет краткое изложение документа,
главное из него и, для коротких документов, перевод целиком. Старый формат .doc не поддерживается.

**Обновление:** скачай и запусти установщик ещё раз (ключ и настройки сохранятся), затем нажми ↻ у расширения в
`chrome://extensions` и обнови вкладку WhatsApp (F5).

**Удаление:** «Параметры Windows» → «Приложения» → WhatsApp AI Digest → «Удалить». Установщик спросит, удалить ли
ещё и ключ. Расширение удали в `chrome://extensions`.

## Сборка из исходников на Windows (по-русски)

Для тех, кто хочет менять код. Всё делается в PowerShell, WSL не нужен. Подробности — в разделах 1–8 ниже.

**1. Установи один раз**

- [Node.js 22 LTS](https://nodejs.org/) или новее.
- pnpm: `npm install -g pnpm`, или `corepack enable` в PowerShell, запущенном от администратора.
- Git, если его ещё нет, и Google Chrome версии 116 или новее.

**2. Скачай проект и укажи ключ Groq**

```powershell
git clone https://github.com/romanro/whatsapp-ai-digest.git
cd whatsapp-ai-digest
Copy-Item apps\server\.env.example apps\server\.env
notepad apps\server\.env
```

В `.env` впиши `GROQ_API_KEY=gsk_...` (ключ берётся на <https://console.groq.com/keys>) и сохрани. Проверить, что ключ
работает: `pnpm --filter @wad/server check-model`.

**3. Собери проект и запусти сервер**

```powershell
pnpm install
pnpm build     # собирает расширение в apps\extension\dist
pnpm start     # сервер на http://127.0.0.1:3741, окно не закрывай
```

Чтобы не держать открытое окно PowerShell, можно собрать приложение для трея. Один раз выполни
`winget install Microsoft.DotNet.SDK.9`, затем `pnpm tray:build` и запускай
`apps\tray-windows\dist\WhatsAppAIDigestTray.exe`. Он запускает сервер в фоне, показывает его статус значком у часов и
может стартовать вместе с Windows.

**4. Загрузи расширение в Chrome**

1. Открой `chrome://extensions` и включи «Режим разработчика» (справа сверху).
2. Нажми «Загрузить распакованное расширение» и выбери папку `apps\extension\dist`.
3. Закрепи значок через кнопку с пазлом.

**5. Пользуйся**

Открой <https://web.whatsapp.com/>, зайди в группу и прокрути чат вверх на нужный период, потом обратно вниз. Затем
нажми значок расширения.

**Обновление:** `git pull`, `pnpm install`, `pnpm build`. Затем ↻ у расширения в `chrome://extensions`, F5 на вкладке
WhatsApp и перезапуск сервера (или «перезапустить» в меню трея).

## Building the Windows installer

`.github/workflows/installer.yml` builds `WhatsAppAIDigestSetup.exe` on every push (download it from the run's
artifacts) and attaches it to a GitHub release when a `v*` tag is pushed (`git tag v0.2.0 && git push origin v0.2.0`).
The installer ([`installer/WhatsAppAIDigest.iss`](installer/WhatsAppAIDigest.iss), Inno Setup 6) bundles `node.exe`, the server bundled
into one file (`pnpm --filter @wad/server bundle`), the tray app and the built extension. It keeps settings in
`%LOCALAPPDATA%\WhatsAppAIDigest\.env`, which the tray app passes to the server as `WAD_ENV_FILE`.

## Project structure

```
apps/
  extension/            Chrome MV3 extension (React + Vite)
    public/manifest.json  permissions: scripting, storage; hosts: web.whatsapp.com, 127.0.0.1
    src/content/          read-only content script; selectors.ts = the only place with WhatsApp DOM selectors
    src/popup/            popup UI (status, group, period, consent, review, summary)
    src/options/          settings + privacy notice
    src/lib/              backend client, payload preparation (period filter, coverage, redaction)
  server/               Local Fastify API
    src/ai/               provider abstraction (Groq / OpenAI / Gemini / Ollama via OpenAI-compatible API), prompts
    src/summarizer.ts     batching, Zod validation of AI output, merge, source-timestamp enrichment
packages/
  shared/               Zod schemas, types, constants, normalization, timestamps, redaction (used by both apps)
```

## 1. Prerequisites

- Windows 10/11 (PowerShell) — macOS/Linux work too. No WSL needed.
- [Node.js 22 LTS or newer](https://nodejs.org/)
- pnpm: `corepack enable` (once, in an elevated PowerShell) or `npm install -g pnpm`
- Google Chrome 116+

## 2. Groq API key

1. Create a free key at <https://console.groq.com/keys>.
2. In PowerShell, from the project folder:
   ```powershell
   Copy-Item apps\server\.env.example apps\server\.env
   notepad apps\server\.env
   ```
3. Set `GROQ_API_KEY=gsk_...` and save. The key stays on the local server and is **never** given to the extension.
4. Optional — verify the key and that the model is available:
   ```powershell
   pnpm --filter @wad/server check-model
   ```
   Default model: `openai/gpt-oss-120b` (Groq production model as of 2026-11-20; same free-tier limits as the 20b model
   but noticeably better at sorting items into sections). `openai/gpt-oss-20b` is a faster alternative.
   Photo analysis uses `VISION_MODEL=qwen/qwen3.8-27b` — Groq's only image model, a *preview* model.

## 3. Install, build and start the backend

```powershell
pnpm install
pnpm build        # builds the extension into apps\extension\dist
pnpm start        # starts the local server on http://127.0.0.1:3741
```

Keep that window open while using the extension. For development, `pnpm dev` runs the server in watch mode and
rebuilds the extension on every change (reload it in `chrome://extensions` afterwards).

Other scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test`.

### Optional: Windows tray app (instead of keeping a terminal open)

`apps/tray-windows` is a ~200 KB tray app (.NET Framework 4.8 — already part of Windows 10/11) that starts the
server hidden, shows its status in the notification area and stops it on exit.

```powershell
winget install Microsoft.DotNet.SDK.9      # once, only needed to BUILD the tray app
pnpm tray:build                            # → apps\tray-windows\dist\WhatsAppAIDigestTray.exe
```

Double-click `WhatsAppAIDigestTray.exe` (pin it to Start or the taskbar if you like). Tray icon colours:
teal = server running and AI ready, orange = starting / AI not configured, gray = stopped or error.
Right-click menu: status, open WhatsApp Web, start / stop / restart server, edit `.env` (creates it from the example),
open the server log (`%LOCALAPPDATA%\WhatsAppAIDigest\server.log` — no message contents), “start with Windows”, exit.
Double-click the icon to open WhatsApp Web. If the server crashes (e.g. port in use), a notification shows the reason.
The Node server is stopped whenever the tray app exits or even crashes (Windows Job Object), so the port is always released.
Keep the exe inside the project folder (it finds the project by walking up); otherwise it asks for the folder once.

## 4. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder `apps\extension\dist`.
4. Pin “WhatsApp AI Digest” in the toolbar (puzzle icon → pin).

The extension has a fixed ID `fjldfeefkijllcoohbgfdodnkoeoedkg` (pinned by the public `key` in the manifest), which
the server allows by default (`ALLOWED_EXTENSION_IDS` in `.env`).

## 5–7. Usage

1. Open <https://web.whatsapp.com/> in Chrome and log in (scan the QR code with your phone).
2. **Select a group:** click the group in the WhatsApp chat list so it is open on the right. Only the open group is
   read; private chats are refused.
3. **Load the period:** WhatsApp only renders part of the history. Scroll the chat **up** until you see messages older
   than the period you want, then scroll back **down** to the newest message.
4. Click the extension icon. Check the three status lines (WhatsApp Web / local server / AI).
5. Choose the period (24 hours / 3 days / 7 days), tick both confirmations, click **Сформировать сводку**.
6. Review what will be sent (message count, time range, what was redacted, coverage warnings) and click
   **Отправить в Groq**.
   Processing runs in the extension's background service worker: you can close the popup. The toolbar badge shows
   “…” while working, ✓ when the summary is ready, ! on error; open the popup to see it.
7. Read the summary — click a source time under an item to see the original message and its full Russian translation.
   Photos you sent that the summary cites (e.g. homework on the board) are shown right there — click to enlarge; **Копировать** copies it as text ready to paste into WhatsApp/Telegram for your wife.
   **Очистить** removes it. ⚙ opens settings.

If the warning **«Период покрыт не полностью»** appears, scroll the chat further up and generate again.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| “Локальный сервер не запущен” | Start the tray app, or run `pnpm start` and keep the window open. |
| Tray icon gray, “Не найден Node.js” | Install Node.js 22+ and restart the tray app (it looks in PATH, Program Files and nvm-windows). |
| Tray: “Зависимости не установлены” | Run `pnpm install` in the project folder. |
| Server says “Port 3741 is already used by another program” | Another app uses 3741. Stop it, or set `PORT=3742` in `apps\server\.env` and `http://127.0.0.1:3742` in extension settings. |
| AI status “нет” / “API-ключ не настроен” | Set `GROQ_API_KEY` in `apps\server\.env`, restart the server. Run `pnpm --filter @wad/server check-model`. |
| “Модель … недоступна” | The model was retired — set another `GROQ_MODEL`. |
| “Превышен лимит запросов” (429) | Groq free tier limits (≈8K tokens/min for gpt-oss). Wait a minute; choose a shorter period; lower `BATCH_MAX_CHARS`. |
| “Откройте вкладку web.whatsapp.com…” | Click the extension icon while the WhatsApp tab is active. |
| “Не удалось подключиться к странице” | Reload the WhatsApp tab (F5) — needed once after installing/updating the extension. |
| “Открыт личный чат” | Only groups are supported. |
| No messages / wrong senders / empty text | WhatsApp changed its markup. Update `apps/extension/src/content/selectors.ts`, rebuild, reload. |
| Dates look a month off | Set the date format in extension settings (DMY vs MDY) — used only when it can't be inferred. |
| 403 `forbidden_origin` | The extension ID differs from `ALLOWED_EXTENSION_IDS` (e.g. you removed the manifest `key`). Add your ID from `chrome://extensions`. |

## 9. Privacy and WhatsApp limitations

**What leaves your computer.** After you confirm, the text of the selected messages (with sender names and times) is
sent from the local server to **Groq**, a cloud AI service, under Groq's terms and privacy policy. This tool does **not**
keep data on your machine only.

**What is done to protect it**

- Nothing is read until you click, nothing is sent until you confirm: every summary shows what will be sent and needs
  **Отправить в Groq**. The consent checkboxes are remembered per group.
- The extension never downloads anything. Text is sent; photos only with “Анализировать фото” (the ones you keep
  selected); documents (PDF/DOCX) only if you download them in WhatsApp yourself and add them in the popup — their text
  is redacted like messages, a scanned PDF goes as its first 3 page images. Video and voice notes are never sent.
- Before upload (in the browser, and again on the server): phone numbers, emails, card numbers, IBANs and URL query
  strings are removed; senders shown as phone numbers become “Участник N”. WhatsApp's internal ids (which contain phone
  numbers) are hashed and never sent.
- **This is basic redaction.** Names, children's names, addresses, health details and other free-form content can still
  be present in the text that is sent.
- The server binds to `127.0.0.1` only, accepts the API only from the allow-listed extension, never logs message text,
  headers or API keys, and stores nothing on disk.
- The extension keeps in the Chrome profile (`chrome.storage.local`, on disk): the last summary of each group (up to 20
  groups, with the messages and photos it cites), the readings of analysed photos (so a photo is sent to Groq only once)
  and the per-group checkboxes. If nothing changed since a group's saved summary, it is shown without sending anything.
  “Очистить” removes one summary; ⚙ → “Удалить сохранённые данные” removes all of it.
- No analytics, telemetry or third-party tracking.

**Prompt-injection protection.** Messages are passed to the model as escaped JSON data inside a delimited block; the
system prompt forbids following instructions found in messages; the model has no tools; its output is only parsed as
JSON, validated with Zod, and every item must cite real message ids — timestamps shown in the UI come from the
extracted messages, not from the model.

**WhatsApp limitations**

- Automated reading of WhatsApp Web may be restricted by WhatsApp's Terms of Service. Use it at your own risk and only
  for groups whose messages you're entitled to process.
- The extension is strictly read-only: it never sends, deletes or edits messages, never clicks or scrolls, doesn't read
  cookies/tokens/session data, doesn't collect contacts, doesn't open other chats and doesn't monitor in the background.
  It doesn't use WhatsApp's protocol or unofficial clients.
- Only messages currently rendered in the open chat are used; coverage gaps are reported.
- Long messages collapsed behind “Read more” are only included up to the visible part (reported as a warning).

## Manual testing of the WhatsApp integration

Use a test group (e.g. a group with only yourself and a second test account).

1. Post a few test messages in Russian, Hebrew and English: an event with a date, a payment (“по 50 ₪ до пятницы”),
   a task, a change (“перенесли на понедельник”), plus a greeting, a phone number and an emoji-only reply.
   Reply to one message with a quote.
2. Load the extension, open the group, click the icon. Expect: all three statuses green and the correct group name.
3. Open a private chat → expect “Открыт личный чат”.
4. In the group, generate a 24h summary. On the review screen check the message count and time range against the chat.
5. Open DevTools on the popup (right-click the popup → Inspect) → Network → the `summarize` request payload. Check that:
   senders/times/text match the chat, quoted text isn't duplicated into the reply, phone numbers are `[телефон скрыт]`,
   emoji are present, Hebrew isn't garbled.
6. Check the summary: greetings excluded, change listed under “Изменения планов”, source times correct.
7. Scroll the chat to the middle and generate again → expect the “not scrolled to bottom” coverage warning.
8. Choose 7 days without scrolling up → expect the “Период покрыт не полностью” warning.

If any step fails, inspect the DOM (DevTools on the WhatsApp tab) and update `selectors.ts` only.

## Configuration (`apps/server/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY` | — | Groq key (required for Groq) |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq model for summaries |
| `VISION_MODEL` | `qwen/qwen3.8-27b` | Model for opt-in photo analysis; `off` disables it |
| `AI_PROVIDER` | `groq` | `groq`, `openai`, `gemini` or `ollama` |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | — | For non-Groq providers |
| `PORT` | `3741` | Local port (loopback only) |
| `ALLOWED_EXTENSION_IDS` | `fjldfeefkijllcoohbgfdodnkoeoedkg` | Comma-separated extension IDs allowed to call the API |
| `BATCH_MAX_CHARS` | `12000` | Message characters per AI request; larger chats are batched and merged |
| `LOG_LEVEL` | `info` | Never logs message content |
