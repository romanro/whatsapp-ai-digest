import net from "node:net";
import { loadConfig } from "./config.ts";
import { createProvider } from "./ai/index.ts";
import { buildApp } from "./app.ts";

const config = loadConfig();
const provider = createProvider(config.ai);
const app = buildApp(config, provider);

/**
 * Some OSes (macOS, Windows) allow binding 127.0.0.1:PORT even when another app listens on 0.0.0.0:PORT,
 * which would silently steal that app's traffic. Refuse to start if anything already answers on the port.
 */
function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

if (await portInUse(config.host, config.port)) {
  app.log.error(
    `Port ${config.port} is already used by another program. Stop it, or set PORT in apps/server/.env ` +
      `and the same address in the extension settings.`,
  );
  process.exit(1);
}

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
