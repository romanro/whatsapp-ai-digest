/** CLI: verifies the API key and that the configured model is available. Usage: pnpm --filter @wad/server check-model */
import { loadConfig } from "./config.ts";
import { createProvider } from "./ai/index.ts";

const cfg = loadConfig();
const provider = createProvider(cfg.ai);
if (!provider.isConfigured()) {
  console.error("No API key configured (GROQ_API_KEY in apps/server/.env).");
  process.exit(1);
}
const status = await provider.checkModel();
if (status.available) {
  console.warn(`OK: ${provider.name} model "${provider.model}" is available.`);
} else {
  console.error(`NOT OK: ${status.message ?? "unknown error"}`);
  process.exit(1);
}
