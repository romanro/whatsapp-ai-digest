// Bundles the server into one ESM file (dist/server.mjs) for the Windows installer: no pnpm, tsx or sources needed.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/server.mjs",
  legalComments: "none",
  logLevel: "info",
  // Bundled CommonJS dependencies (fastify, pino…) call require().
  banner: { js: 'import { createRequire as __wadCreateRequire } from "node:module"; const require = __wadCreateRequire(import.meta.url);' },
});
