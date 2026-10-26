import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { APIRequestContext, Page } from "@playwright/test";

import { E2E_BASE_URL, E2E_MASTER_KEY } from "./constants";

export type EntryInput = {
  occurredOn: string;
  kind: "income" | "expense";
  amountYen: number;
  description: string;
};

export type Cursor = { occurredOn: string; createdAt: number; id: string };

export type Entry = EntryInput & {
  id: string;
  fundId: string;
  receiptId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type Fund = {
  id: string;
  name: string;
  openingBalanceYen: number;
  createdAt: number;
  incomeYen: string;
  expenseYen: string;
  balanceYen: string;
};

export type DraftEntry = {
  occurredOn: string | null;
  kind: "income" | "expense" | null;
  amountYen: number | null;
  description: string;
};

type RpcEnvelope<T> = { json: T };

export async function rpc<T>(
  request: APIRequestContext,
  procedure: string,
  input: unknown,
): Promise<T> {
  const response = await request.post(`${E2E_BASE_URL}/rpc/${procedure}`, {
    data: { json: input },
  });
  const payload = (await response.json()) as RpcEnvelope<T> | { json: { message?: string } };
  if (!response.ok()) {
    throw new Error(`${procedure} returned HTTP ${response.status()}: ${JSON.stringify(payload)}`);
  }
  if (!payload || typeof payload !== "object" || !("json" in payload)) {
    throw new Error(`${procedure} returned an invalid RPC envelope`);
  }
  return payload.json as T;
}

export async function createTestFund(
  request: APIRequestContext,
  label = "ledger",
  openingBalanceYen = 0,
): Promise<{ fundId: string; name: string; url: string }> {
  const name = `E2E ${label} ${randomUUID().slice(0, 8)}`;
  const result = await rpc<{ fundId: string }>(request, "funds/create", {
    masterKey: E2E_MASTER_KEY,
    name,
    openingBalanceYen,
  });
  return { ...result, name, url: `${E2E_BASE_URL}/f/${result.fundId}` };
}

export async function openFund(page: Page, fund: { url: string; name: string }): Promise<void> {
  await page.goto(fund.url);
  await page.getByRole("heading", { level: 1, name: fund.name }).waitFor({ state: "visible" });
  await page.locator('input[type="file"]:not(:disabled)').waitFor({ state: "attached" });
}

export async function createEntries(
  request: APIRequestContext,
  fundId: string,
  entries: EntryInput[],
): Promise<{ entryIds: string[]; receiptId: string | null }> {
  return rpc(request, "entries/createBatch", {
    fundId,
    submissionId: randomUUID(),
    entries,
  });
}

export async function listEntries(
  request: APIRequestContext,
  fundId: string,
  cursor?: Cursor,
): Promise<{ items: Entry[]; nextCursor: Cursor | null }> {
  return rpc(request, "entries/list", { fundId, ...(cursor ? { cursor } : {}) });
}

export async function getFund(request: APIRequestContext, fundId: string): Promise<Fund> {
  return rpc(request, "funds/get", { fundId });
}

export const TEST_PNG = readFileSync(new URL("../public/logo.png", import.meta.url));

export type DroppedFile = { name: string; mimeType: string; buffer: Buffer };

export function pngFile(name = "receipt.png"): DroppedFile {
  return { name, mimeType: "image/png", buffer: Buffer.from(TEST_PNG) };
}

export async function dropFiles(page: Page, files: DroppedFile[], dropCount = 1): Promise<void> {
  const encoded = files.map(({ name, mimeType, buffer }) => ({
    name,
    mimeType,
    base64: buffer.toString("base64"),
  }));
  await page.evaluate(
    ({ items, dropCount }) => {
      const target = document.querySelector(".dropzone");
      if (!target) throw new Error("Image drop target is missing");
      for (let drop = 0; drop < dropCount; drop += 1) {
        const transfer = new DataTransfer();
        for (const item of items) {
          const binary = atob(item.base64);
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          transfer.items.add(new File([bytes], item.name, { type: item.mimeType }));
        }
        target.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }
    },
    { items: encoded, dropCount },
  );
}

export async function installScanFixture(
  page: Page,
  entries: DraftEntry[],
  warnings: string[] = [],
): Promise<{ calls: () => number }> {
  let calls = 0;
  await page.route("**/rpc/receipts/scan", async (route) => {
    calls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: { entries, warnings } }),
    });
  });
  return { calls: () => calls };
}

export async function receiptBytes(
  request: APIRequestContext,
  fundId: string,
  receiptId: string,
): Promise<Buffer> {
  const response = await request.get(`${E2E_BASE_URL}/api/funds/${fundId}/receipts/${receiptId}`);
  if (!response.ok()) throw new Error(`Receipt returned HTTP ${response.status()}`);
  return response.body();
}
