import { readMigrationFiles } from "drizzle-orm/migrator";
import { Miniflare } from "miniflare";
import { fileURLToPath, URL } from "node:url";
import { createRouterClient } from "@orpc/server";
import { createDb, type Database } from "@zandaka/db";
import { appRouter } from "./routers/index";
import type { AppRouterClient } from "./routers/index";
import type { Context } from "./context";

const migrationsFolder = fileURLToPath(new URL("../../db/src/migrations/", import.meta.url));
type TestFixture = {
  d1: D1Database;
  receipts: R2Bucket;
  db: Database;
  context: Context;
  client: AppRouterClient;
  close: () => Promise<void>;
};

export async function createTestFixture(
  options: {
    masterKey?: string | null;
    openRouterApiKey?: string;
    r2?: R2Bucket;
  } = {},
): Promise<TestFixture> {
  const miniflare = new Miniflare({
    workers: [
      {
        config: {
          name: "zandaka-api-tests",
          compatibilityDate: "2026-10-26",
          manifest: {
            mainModule: "test-worker.mjs",
            modules: {
              "test-worker.mjs": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } }",
              },
            },
          },
          env: {
            DB: { type: "d1", id: "zandaka-test-db", name: "zandaka-test-db" },
            RECEIPTS: { type: "r2", name: "zandaka-test-receipts" },
          },
        },
      },
    ],
  });
  const d1 = await miniflare.getD1Database("DB");
  const receipts = (options.r2 ?? (await miniflare.getR2Bucket("RECEIPTS"))) as R2Bucket;

  for (const migration of readMigrationFiles({ migrationsFolder })) {
    await d1.batch(migration.sql.map((statement) => d1.prepare(statement)));
  }

  const db = createDb({ DB: d1 });
  const context: Context = {
    db,
    receipts,
    masterKey:
      options.masterKey === null
        ? undefined
        : (options.masterKey ?? "test-master-key-with-32-bytes-minimum"),
    openRouterApiKey: options.openRouterApiKey,
    scanLimit: { limit: async () => ({ success: true }) } as RateLimit,
  };
  const client = createRouterClient(appRouter, { context: () => context });

  return {
    d1,
    receipts,
    db,
    context,
    client,
    close: () => miniflare.dispose(),
  };
}

export const testMasterKey = "test-master-key-with-32-bytes-minimum";

export function uuid() {
  return crypto.randomUUID();
}

export function makeEntry(
  overrides: Partial<{
    occurredOn: string;
    kind: "income" | "expense";
    amountYen: number;
    description: string;
  }> = {},
) {
  return {
    occurredOn: "2026-10-01",
    kind: "income" as const,
    amountYen: 2000,
    description: "会費",
    ...overrides,
  };
}

export function file(bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), name = "receipt.jpg") {
  return new File([bytes], name, { type: "image/jpeg" });
}
