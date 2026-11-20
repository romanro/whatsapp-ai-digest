# WhatsApp AI Digest

On-demand, **read-only** Chrome extension + local server that turns the messages of the currently open WhatsApp Web
**group** into a short structured summary **in Russian**: announcements, dates & events, tasks, payments, plan changes
and other important information — each item with the original message timestamps.

```
Chrome popup (React) ──► content script (reads visible messages of the open group, on click only)
        │
        └─ redacted, user-confirmed JSON ──► local Fastify server 127.0.0.1:3001 ──► Groq API (OpenAI-compatible)
```

> ⚠️ **Status of the WhatsApp integration:** the DOM selectors in
> [`apps/extension/src/content/selectors.ts`](apps/extension/src/content/selectors.ts) are based on the publicly known
> WhatsApp Web structure and are covered by tests against a *synthetic* DOM. They have **not** been verified against the
> live WhatsApp Web UI by the author. Follow [Manual testing](#manual-testing-of-the-whatsapp-integration) before relying on it.

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
   Default model: `openai/gpt-oss-20b` (listed as a Groq production model as of 2026-11-20). Change `GROQ_MODEL` if it's
   retired; `openai/gpt-oss-120b` and `llama-3.3-70b-versatile` are alternatives.

## 3. Install, build and start the backend

```powershell
pnpm install
pnpm build        # builds the extension into apps\extension\dist
pnpm start        # starts the local server on http://127.0.0.1:3001
```

Keep that window open while using the extension. For development, `pnpm dev` runs the server in watch mode and
rebuilds the extension on every change (reload it in `chrome://extensions` afterwards).

Other scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test`.

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
7. Read the summary; **Копировать** copies it as text ready to paste into WhatsApp/Telegram for your wife.
   **Очистить** removes it. ⚙ opens settings.

If the warning **«Период покрыт не полностью»** appears, scroll the chat further up and generate again.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| “Локальный сервер не запущен” | Run `pnpm start` and keep the window open. |
| Server says “Port 3001 is already used by another program” | Another app uses 3001. Stop it, or set `PORT=3002` in `apps\server\.env` and `http://127.0.0.1:3002` in extension settings. |
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

- Nothing is read until you click, nothing is sent until you confirm; consent is required for every summary.
- Text only: media, voice notes and files are never downloaded or sent.
- Before upload (in the browser, and again on the server): phone numbers, emails, card numbers, IBANs and URL query
  strings are removed; senders shown as phone numbers become “Участник N”. WhatsApp's internal ids (which contain phone
  numbers) are hashed and never sent.
- **This is basic redaction.** Names, children's names, addresses, health details and other free-form content can still
  be present in the text that is sent.
- The server binds to `127.0.0.1` only, accepts the API only from the allow-listed extension, never logs message text,
  headers or API keys, and stores nothing on disk. The last summary is kept in Chrome session memory until the browser
  closes or you click “Очистить”.
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
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Groq model |
| `AI_PROVIDER` | `groq` | `groq`, `openai`, `gemini` or `ollama` |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | — | For non-Groq providers |
| `PORT` | `3001` | Local port (loopback only) |
| `ALLOWED_EXTENSION_IDS` | `fjldfeefkijllcoohbgfdodnkoeoedkg` | Comma-separated extension IDs allowed to call the API |
| `BATCH_MAX_CHARS` | `12000` | Message characters per AI request; larger chats are batched and merged |
| `LOG_LEVEL` | `info` | Never logs message content |
