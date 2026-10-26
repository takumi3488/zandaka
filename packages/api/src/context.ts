import type { Database } from "@zandaka/db";

export type Context = {
  db: Database;
  receipts: R2Bucket;
  masterKey: string | undefined;
  openRouterApiKey: string | undefined;
  scanLimit: RateLimit;
};
