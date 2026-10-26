import type { Context as ApiContext } from "@zandaka/api/context";

import { ENV } from "./env.server";
import { getDb } from "./services";

export async function createContext(): Promise<ApiContext> {
  const db = await getDb();
  return {
    db,
    receipts: ENV.RECEIPTS,
    masterKey: ENV.MASTER_KEY,
    openRouterApiKey: ENV.OPENROUTER_API_KEY,
    scanLimit: ENV.LLM_SCAN_LIMIT,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
