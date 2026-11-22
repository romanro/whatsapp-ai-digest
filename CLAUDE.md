# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only Chrome MV3 extension plus a local Fastify server. When the user clicks, it summarizes the open WhatsApp Web **group** in Russian. The data flow: popup → content script extracts the rendered messages → payload is redacted in the browser → the user reviews and confirms → a background service-worker job POSTs it to `127.0.0.1:3741` → the server redacts again, batches the messages and calls an OpenAI-compatible LLM (Groq by default). User-facing strings (UI, errors, prompts) are in Russian. Code and comments are in English.

## Commands

pnpm workspace (Node ≥ 22.15, pnpm 10). Run from the repo root:

```sh
pnpm install
pnpm build          # builds the extension into apps/extension/dist (load unpacked in chrome://extensions)
pnpm start          # server on 127.0.0.1:3741 (needs apps/server/.env, copy from .env.example)
pnpm dev            # server --watch + extension rebuild-on-change (reload the extension manually)
pnpm lint           # eslint, whole repo
pnpm typecheck      # tsc in every package
pnpm test           # vitest in every package
pnpm --filter @wad/server check-model   # verify API key + model availability
pnpm tray:build     # Windows tray app (.NET), apps/tray-windows
pnpm --filter @wad/server bundle   # server → one file apps/server/dist/server.mjs (used by the installer)
```

Run a single test file or test: `pnpm --filter @wad/server exec vitest run test/summarizer.test.ts -t "name"`. The package filters are `@wad/server`, `@wad/extension` and `@wad/shared`.

There is no TS compile step for the server or shared. The server runs TS directly via `tsx`. `@wad/shared` exports `./src/index.ts` as source. Imports use explicit `.ts` extensions (`allowImportingTsExtensions`, `verbatimModuleSyntax`), so use `import type` for type-only imports.

## Architecture

**`packages/shared`**: the contract between the two apps. It holds Zod schemas (`SummarizeRequestSchema`, `AiSummarySchema`, `HealthResponseSchema`…), `LIMITS`, `SECTION_KEYS`, timestamp parsing, period filtering and coverage, and redaction/pseudonymization. Both apps use the same redaction code (the browser runs it before upload, the server runs it again). Change schemas here, and both apps pick the change up.

**`apps/extension`** has two Vite builds (see the `build` script):
- `vite.config.ts` builds the popup + options pages (React 19) and `background.js` (an ES-module service worker at a fixed path that the manifest references).
- `vite.content.config.ts` builds `content.js` as a classic IIFE, because content scripts can't be ES modules. It is injected on demand with `chrome.scripting.executeScript` (`src/lib/chrome.ts`) and guards against double install.
- `src/content/selectors.ts` is the **only** place for WhatsApp DOM selectors. Each entry is an ordered list of fallbacks, and the file header records what has been verified against the live UI. When extraction breaks, fix it there. Tests in `test/extractor.test.ts` run against a synthetic DOM (`test/dom-fixture.ts`, happy-dom).
- `src/lib/protocol.ts` holds the popup↔content messages (`wad:probe`, `wad:extract`, `wad:images`). `src/lib/jobs.ts` holds the popup↔background messages (`wad:bg:*`).
- `src/lib/pipeline.ts` (`preparePayload`) is the browser-side filter, redaction and limits code that runs before the review screen. Photos are opt-in: they are attached only after the user picks them.
- `src/lib/jobs.ts` has a `JobRunner`, which takes injected `JobDeps` so tests can supply them. It runs the summarize request in the service worker so the popup can close. State (job, last result, cited photos) lives in `chrome.storage.session` only. A job still marked `running` when the worker restarts is reported as interrupted.
- The manifest `key` pins the extension ID `fjldfeefkijllcoohbgfdodnkoeoedkg`. The server allow-lists that ID as an Origin (`ALLOWED_EXTENSION_IDS`).

**`apps/server`**:
- `app.ts` (`buildApp(config, provider)`): accepts only loopback `Host` (DNS-rebinding guard), requires an allow-listed `Origin` on `/api/*`, and handles one summarize at a time (409 `busy`). The logger serializers drop headers and bodies, so **never log message content**. `AiError` codes map to HTTP statuses.
- `ai/provider.ts` defines the `AiProvider` interface, and the summarizer depends only on it. `openai-compatible.ts` is the single implementation (Groq/OpenAI/Gemini/Ollama via base URL). Tests use `test/fake-provider.ts`.
- `summarizer.ts`: optional vision pass (photo → "[Фото: …]" text merged into messages) → `chunkMessages` by `BATCH_MAX_CHARS` → a per-batch JSON completion → `coerceAiOutput`/`parseAiSummary` (Zod) → merge → `enrichSummary`. `enrichSummary` replaces model-cited ids with real timestamps and sources from the extracted messages. UI timestamps never come from the model.
- `ai/prompt.ts`: messages go to the model as escaped JSON inside a delimited block, and the prompt forbids following instructions inside them (prompt-injection defense). Keep that property when editing prompts.

**`apps/tray-windows`**: a .NET Framework 4.8 WinForms tray app. It starts and stops the Node server inside a Job Object and polls `/health`. It is separate from the JS toolchain. `Layout.Detect()` (Paths.cs) supports two layouts: a source checkout (runs `tsx src/index.ts`, settings in `apps/server/.env`) and the installed one (bundled `node\node.exe` + `server\server.mjs`, settings in `%LOCALAPPDATA%\WhatsAppAIDigest\.env`, passed to the server as `WAD_ENV_FILE`).

**`installer/`** + `.github/workflows/installer.yml`: the Inno Setup installer is built only in CI on a Windows runner (on every push; attached to a release on `v*` tags). CI also runs a silent install, starts the installed server and checks `/health`. Inno Setup is not available on macOS, so the CI run is the only way to verify changes to the `.iss` file.

## Invariants to preserve

- The extension is strictly read-only on WhatsApp Web. It never clicks, scrolls, sends or edits, and it never reads cookies or storage. It reads only the DOM that is currently rendered, and only after the user clicks. Documents (PDF/DOCX) are therefore never fetched from WhatsApp: the content script only reports document cards (names); the user clicks "Download" in WhatsApp and the popup finds the file in Chrome's download history (`src/lib/downloads.ts`, `downloads` permission), fetching its bytes from the local server's `POST /api/local-document` (absolute path, PDF/DOCX regular files only, ≤ 30 MB). As a fallback the user adds the file by hand in full-tab mode (a file dialog closes the small popup). Then `src/lib/documents.ts` extracts text (pdf.js, mammoth) or renders scanned pages. The server digests each document (`apps/server/src/documents.ts`, chunked for rate limits) and the digest is merged into its message like a photo reading.
- Nothing is sent without per-summary user confirmation (the review screen's send button is the only consent step; only the photo switch is remembered per group). The redaction runs in the browser and again on the server.
- The server binds to loopback only, stores nothing on disk (it only reads the one downloaded document it is asked for) and logs metadata only. Persistence lives only in the extension (`src/lib/cache.ts`, `chrome.storage.local`): per-group saved summaries, photo readings by photo hash and the per-group photo switch. `JobRunner` reuses a saved summary when the request fingerprint is unchanged and sends previously read photos as `{ reading }` instead of `{ dataUrl }`; the server returns fresh readings in `meta.imageReadings`. Extension and server must be updated together (the installer ships both).
