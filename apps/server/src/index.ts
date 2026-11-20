import { loadConfig } from "./config.ts";
import { createProvider } from "./ai/index.ts";
import { buildApp } from "./app.ts";

const config = loadConfig();
const provider = createProvider(config.ai);
const app = buildApp(config, provider);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { provider: provider.name, model: provider.model, aiConfigured: provider.isConfigured(), origins: config.allowedOrigins },
    "WhatsApp AI Digest server ready",
  );
  if (!provider.isConfigured()) {
    app.log.warn("No AI API key configured. Copy apps/server/.env.example to apps/server/.env and set GROQ_API_KEY.");
  } else {
    provider.checkModel().then(
      (s) => {
        if (s.available === false) app.log.warn(s.message ?? "Configured model is not available");
        else if (s.available) app.log.info(`Model ${provider.model} is available`);
      },
      () => undefined,
    );
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0));
  });
}
