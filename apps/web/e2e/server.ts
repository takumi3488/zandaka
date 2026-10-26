import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Context as ApiContext } from "@zandaka/api/context";
import { createTestFixture } from "@zandaka/api/test-fixture";
import { createServer, type ViteDevServer } from "vite";

import { E2E_BASE_URL, E2E_MASTER_KEY } from "./constants";

type E2EGlobal = typeof globalThis & { __ZANDAKA_E2E_ENV?: Env };
type E2EFixture = {
  d1: Env["DB"];
  receipts: Env["RECEIPTS"];
  context: Pick<ApiContext, "scanLimit">;
  close: () => Promise<void>;
};

async function main() {
  let fixture: E2EFixture | undefined;
  let vite: ViteDevServer | undefined;
  let closePromise: Promise<void> | undefined;

  const close = () => {
    if (!closePromise) {
      closePromise = (async () => {
        try {
          await vite?.close();
        } finally {
          try {
            await fixture?.close();
          } finally {
            delete (globalThis as E2EGlobal).__ZANDAKA_E2E_ENV;
          }
        }
      })();
    }
    return closePromise;
  };

  const handleSignal = () => {
    void close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Failed to close the isolated E2E server.", error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    fixture = await createTestFixture({ masterKey: E2E_MASTER_KEY });
    (globalThis as E2EGlobal).__ZANDAKA_E2E_ENV = {
      DB: fixture.d1,
      RECEIPTS: fixture.receipts,
      MASTER_KEY: E2E_MASTER_KEY,
      OPENROUTER_API_KEY: undefined,
      LLM_SCAN_LIMIT: fixture.context.scanLimit,
    } as unknown as Env;

    vite = await createServer({
      configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
      root: fileURLToPath(new URL("..", import.meta.url)),
      logLevel: "error",
    });
    await vite.listen();
    process.stdout.write(`Isolated E2E server ready at ${E2E_BASE_URL}\n`);
  } catch (error) {
    await close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error("Failed to start the isolated E2E server.", error);
  process.exitCode = 1;
});
