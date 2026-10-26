import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import "varlock/auto-load";

export const db = Cloudflare.D1.Database("database", {
  migrations: "../../packages/db/src/migrations",
});

export const receipts = Cloudflare.R2.Bucket("receipts");

export const web = Cloudflare.Website.Vite("web", {
  rootDir: "../../apps/web",
  compatibility: {
    flags: ["nodejs_compat", "global_fetch_strictly_public"],
  },
  env: {
    DB: db,
    RECEIPTS: receipts,
    MASTER_KEY: Config.Redacted("MASTER_KEY"),
    OPENROUTER_API_KEY: Config.Redacted("OPENROUTER_API_KEY"),
    LLM_SCAN_LIMIT: Cloudflare.RateLimit("LLM_SCAN_LIMIT", {
      namespaceId: 18360231,
      simple: { limit: 10, period: 60 },
    }),
  },
  dev: {
    port: 3001,
  },
});

export const receiptCleanup = Cloudflare.Worker("receipt-cleanup", {
  main: "./src/receipt-cleanup.ts",
  env: { DB: db, RECEIPTS: receipts },
  crons: ["17 * * * *"],
  workersDev: false,
});

export type WebEnv = Cloudflare.InferEnv<typeof web>;

export default Alchemy.Stack(
  "zandaka",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const webWorker = yield* web;

    yield* receiptCleanup;
    return {
      web: webWorker.url,
    };
  }),
);
