import { cleanupReceipts } from "@zandaka/api/receipt-storage";
import { createDb } from "@zandaka/db";

type ReceiptCleanupEnv = {
  DB: D1Database;
  RECEIPTS: R2Bucket;
};

export default {
  async scheduled(_controller: ScheduledController, env: ReceiptCleanupEnv): Promise<void> {
    await cleanupReceipts(createDb(env), env.RECEIPTS, Date.now());
  },

  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
};
