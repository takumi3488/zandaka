import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import {
  createTestFund,
  dropFiles,
  getFund,
  installScanFixture,
  listEntries,
  openFund,
  pngFile,
  receiptBytes,
  TEST_PNG,
  type DraftEntry,
} from "./helpers";

type FileTrace = { name: string; mimeType: string; bytes: number[] };

type FetchTrace = {
  calls: number;
  textParts: Array<Array<[string, string]>>;
  fileParts: Array<FileTrace[]>;
  retryResponse?: unknown;
  threwOnce: boolean;
};

function deferred() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}

async function saveManual(page: Page, amount: number, description: string): Promise<void> {
  await page.getByLabel("区分").selectOption("expense");
  await page.getByLabel("日付").fill("2026-10-03");
  await page.getByLabel("金額（円）").fill(String(amount));
  await page.getByLabel("内容").fill(description);
  await page.getByRole("button", { name: "手入力で記帳する" }).click();
  await expect(page.getByRole("status").filter({ hasText: "記帳しました" })).toBeVisible();
}

async function firstReceipt(request: APIRequestContext, fundId: string) {
  const entries = await listEntries(request, fundId);
  expect(entries.items.length).toBeGreaterThan(0);
  const receiptId = entries.items[0]!.receiptId;
  expect(receiptId).not.toBeNull();
  expect(entries.items.every((entry) => entry.receiptId === receiptId)).toBe(true);
  expect(await receiptBytes(request, fundId, receiptId!)).toEqual(TEST_PNG);
  return receiptId!;
}

test("the picker stays disabled until hydration and then saves normally", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "hydration-ready");
  const releaseScripts = deferred();
  const origin = new URL(fund.url).origin;
  let scriptRequests = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin === origin && request.resourceType() === "script") {
      scriptRequests += 1;
      await releaseScripts.promise;
    }
    await route.continue();
  });
  const scan = await installScanFixture(page, [
    { occurredOn: "2026-10-04", kind: "expense", amountYen: 75, description: "hydrated picker" },
  ]);

  try {
    await page.goto(fund.url, { waitUntil: "commit" });
    await expect.poll(() => scriptRequests).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { level: 1, name: fund.name })).toBeVisible();
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeDisabled();
    await expect(page.getByRole("button", { name: "手入力で記帳する" })).toBeDisabled();

    releaseScripts.resolve();
    await expect(fileInput).toBeEnabled();
    await fileInput.setInputFiles(pngFile());
    await expect(page.locator("article.record-row")).toHaveCount(1);
    expect(scan.calls()).toBe(1);
    expect((await listEntries(request, fund.fundId)).items).toHaveLength(1);
    expect((await getFund(request, fund.fundId)).balanceYen).toBe("-75");
    await firstReceipt(request, fund.fundId);
  } finally {
    releaseScripts.resolve();
  }
});

test("the picker saves extracted rows with one shared original receipt", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "picker-receipt");
  const drafts: DraftEntry[] = [
    { occurredOn: "2026-10-01", kind: "income", amountYen: 2000, description: "fixture dues" },
    { occurredOn: "2026-10-02", kind: "expense", amountYen: 350, description: "fixture supplies" },
  ];
  const scan = await installScanFixture(page, drafts, ["scan transport fixture"]);
  await page.setViewportSize({ width: 375, height: 812 });
  await openFund(page, fund);
  await page.locator('input[type="file"]').setInputFiles(pngFile());

  await expect(page.locator("article.record-row")).toHaveCount(2);
  expect(scan.calls()).toBe(1);
  await expect(page.getByRole("region", { name: "残高の概要" })).toContainText("1,650円");
  const receiptId = await firstReceipt(request, fund.fundId);
  const thumbnails = page.getByRole("img", { name: "証憑画像" });
  await expect(thumbnails).toHaveCount(2);
  await thumbnails.first().scrollIntoViewIfNeeded();
  await expect(thumbnails.first()).toBeInViewport();
  await expect(thumbnails.first()).toHaveJSProperty("naturalWidth", 500);
  const box = await thumbnails.first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThan(375);
  expect(Math.abs(box!.x + box!.width / 2 - 375 / 2)).toBeLessThan(12);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  const imageLink = page.locator(`a.record-receipt[href$="/${receiptId}"]`).first();
  const popupPromise = page.waitForEvent("popup");
  await imageLink.click();
  const popup = await popupPromise;
  await expect(popup.locator("img")).toBeVisible();
  await expect(popup.locator("img")).toHaveJSProperty("naturalWidth", 500);
});

test("drag-and-drop locks scan and save, then writes one shared receipt", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "drop-locks");
  const releaseScan = deferred();
  const releaseSave = deferred();
  let scanCalls = 0;
  let saveCalls = 0;
  const drafts: DraftEntry[] = [
    { occurredOn: "2026-10-04", kind: "expense", amountYen: 75, description: "dropped receipt" },
  ];
  await page.route("**/rpc/receipts/scan", async (route) => {
    scanCalls += 1;
    await releaseScan.promise;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: { entries: drafts, warnings: [] } }),
    });
  });
  await page.route("**/rpc/entries/createBatch", async (route) => {
    saveCalls += 1;
    await releaseSave.promise;
    await route.continue();
  });
  await openFund(page, fund);

  try {
    const file = pngFile("dropped.png");
    await dropFiles(page, [file], 2);
    await expect.poll(() => scanCalls).toBe(1);
    await expect(page.getByRole("status").filter({ hasText: "画像を読み取り中" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeDisabled();
    await expect(page.getByRole("button", { name: "手入力で記帳する" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "画像を外す" }).and(page.locator(":enabled")),
    ).toHaveCount(0);
    await expect(page.getByLabel("金額（円）")).toBeDisabled();
    expect(scanCalls).toBe(1);
    releaseScan.resolve();

    await expect.poll(() => saveCalls).toBe(1);
    await expect(page.getByRole("status").filter({ hasText: "記帳中" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeDisabled();
    await expect(page.getByRole("button", { name: "手入力で記帳する" })).toBeDisabled();
    await expect(page.getByLabel("金額（円）")).toBeDisabled();
    expect(saveCalls).toBe(1);
    releaseSave.resolve();

    await expect(page.locator("article.record-row")).toHaveCount(1);
    expect(scanCalls).toBe(1);
    expect(saveCalls).toBe(1);
    await firstReceipt(request, fund.fundId);
    expect((await getFund(request, fund.fundId)).balanceYen).toBe("-75");
  } finally {
    releaseScan.resolve();
    releaseSave.resolve();
  }
});

test("empty, incomplete, and invalid scan results save no candidates and keep the image for manual entry", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "empty-null-fallback");
  let scans = 0;
  let saves = 0;
  await page.route("**/rpc/receipts/scan", async (route) => {
    scans += 1;
    let entries: DraftEntry[];
    if (scans === 1) {
      entries = [];
    } else if (scans === 2) {
      entries = [
        {
          occurredOn: "2026-10-05",
          kind: "income",
          amountYen: 100,
          description: "otherwise valid candidate",
        },
        { occurredOn: null, kind: null, amountYen: null, description: "uncertain" },
      ];
    } else {
      entries = [
        {
          occurredOn: "2026-02-30",
          kind: "expense",
          amountYen: 50,
          description: "invalid calendar date",
        },
      ];
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: { entries, warnings: [] } }),
    });
  });
  page.on("request", (requestEvent) => {
    if (requestEvent.url().endsWith("/rpc/entries/createBatch")) saves += 1;
  });
  const expectNoCommit = async () => {
    expect(saves).toBe(0);
    expect((await listEntries(request, fund.fundId)).items).toHaveLength(0);
    expect((await getFund(request, fund.fundId)).balanceYen).toBe("0");
  };

  await openFund(page, fund);
  await page.locator('input[type="file"]').setInputFiles(pngFile());
  await expect(page.getByRole("alert")).toContainText("読み取れる入出金がありませんでした");
  await expect(page.getByRole("img", { name: "選択した画像のプレビュー" })).toBeVisible();
  expect(scans).toBe(1);
  await expectNoCommit();

  const secondScan = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/receipts/scan") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "画像を読み直す" }).click();
  await secondScan;
  await expect(page.getByRole("alert")).toContainText("何も保存していません");
  await expect(page.getByRole("img", { name: "選択した画像のプレビュー" })).toBeVisible();
  expect(scans).toBe(2);
  await expectNoCommit();

  const thirdScan = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/receipts/scan") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "画像を読み直す" }).click();
  await thirdScan;
  await expect(page.getByRole("alert")).toContainText("何も保存していません");
  await expect(page.getByRole("img", { name: "選択した画像のプレビュー" })).toBeVisible();
  expect(scans).toBe(3);
  await expectNoCommit();

  await saveManual(page, 225, "manual fallback");
  expect(saves).toBe(1);
  const receiptId = await firstReceipt(request, fund.fundId);
  expect(await receiptBytes(request, fund.fundId, receiptId)).toEqual(TEST_PNG);
  await expect(page.locator("article.record-row")).toContainText("manual fallback");
});

test("an unavailable scan keeps the original image available for manual evidence", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "scan-failure");
  let scans = 0;
  let saves = 0;
  page.on("request", (requestEvent) => {
    if (requestEvent.url().endsWith("/rpc/receipts/scan")) scans += 1;
    if (requestEvent.url().endsWith("/rpc/entries/createBatch")) saves += 1;
  });
  await openFund(page, fund);
  await page.locator('input[type="file"]').setInputFiles(pngFile());
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("img", { name: "選択した画像のプレビュー" })).toBeVisible();
  expect(scans).toBe(1);
  expect(saves).toBe(0);
  expect((await listEntries(request, fund.fundId)).items).toHaveLength(0);

  await saveManual(page, 450, "manual after scan unavailable");
  expect(saves).toBe(1);
  const receiptId = await firstReceipt(request, fund.fundId);
  expect(await receiptBytes(request, fund.fundId, receiptId)).toEqual(TEST_PNG);
});

test("unsupported, multiple, and oversized drops never call scan or save", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "rejected-images");
  let scans = 0;
  let saves = 0;
  page.on("request", (requestEvent) => {
    if (requestEvent.url().endsWith("/rpc/receipts/scan")) scans += 1;
    if (requestEvent.url().endsWith("/rpc/entries/createBatch")) saves += 1;
  });
  await openFund(page, fund);

  await dropFiles(page, [
    { name: "animation.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") },
  ]);
  await expect(page.getByRole("alert")).toBeVisible();
  await dropFiles(page, [pngFile("first.png"), pngFile("second.png")]);
  await expect(page.getByRole("alert")).toBeVisible();
  await page.evaluate(() => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "too-large.png", { type: "image/png" }));
    document
      .querySelector(".dropzone")!
      .dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
  });
  await expect(page.getByRole("alert")).toBeVisible();

  expect(scans).toBe(0);
  expect(saves).toBe(0);
  expect((await listEntries(request, fund.fundId)).items).toHaveLength(0);
  expect((await getFund(request, fund.fundId)).balanceYen).toBe("0");
});

test("a committed save whose response is lost can be retried with the same payload once", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "response-loss");
  const scan = await installScanFixture(page, [
    { occurredOn: "2026-10-05", kind: "expense", amountYen: 630, description: "committed once" },
  ]);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const trace: FetchTrace = { calls: 0, textParts: [], fileParts: [], threwOnce: false };
    const tracedWindow = window as Window & { __e2eFetchTrace?: FetchTrace };
    tracedWindow.__e2eFetchTrace = trace;
    window.fetch = async (...args) => {
      const input = args[0];
      const url = input instanceof Request ? input.url : String(input);
      const method = args[1]?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.endsWith("/rpc/entries/createBatch") && method === "POST") {
        trace.calls += 1;
        const body = args[1]?.body;
        const inputRequest = input instanceof Request ? input : undefined;
        const form =
          body instanceof FormData
            ? body
            : inputRequest?.headers.get("content-type")?.includes("multipart/form-data")
              ? await inputRequest.clone().formData()
              : undefined;
        const fields: Array<[string, string]> = [];
        const files: FileTrace[] = [];
        if (form) {
          for (const [key, value] of form.entries()) {
            if (typeof value === "string") {
              fields.push([key, value]);
            } else {
              files.push({
                name: value.name,
                mimeType: value.type,
                bytes: Array.from(new Uint8Array(await value.arrayBuffer())),
              });
            }
          }
        } else if (typeof body === "string") {
          fields.push(["body", body]);
        }
        trace.textParts.push(fields);
        trace.fileParts.push(files);
        const response = await originalFetch(...args);
        if (!trace.threwOnce) {
          trace.threwOnce = true;
          throw new TypeError("simulated lost response after server commit");
        }
        trace.retryResponse = await response.clone().json();
        return response;
      }
      return originalFetch(...args);
    };
  });
  await openFund(page, fund);
  await page.locator('input[type="file"]').setInputFiles(pngFile("committed.png"));
  await expect(page.getByRole("heading", { name: "記帳結果を確認してください" })).toBeVisible();
  await expect(page.getByRole("button", { name: "同じ内容で結果を確認" })).toBeEnabled();
  await expect(page.locator('input[type="file"]')).toBeDisabled();
  await expect(page.getByRole("button", { name: "手入力で記帳する" })).toBeDisabled();
  expect(scan.calls()).toBe(1);
  let trace = await page.evaluate(() => {
    const tracedWindow = window as Window & { __e2eFetchTrace?: FetchTrace };
    if (!tracedWindow.__e2eFetchTrace) throw new Error("Response-loss trace is missing");
    return tracedWindow.__e2eFetchTrace;
  });
  expect(trace.calls).toBe(1);
  expect(trace.threwOnce).toBe(true);
  expect(trace.textParts[0]!.length).toBeGreaterThan(0);
  expect(trace.fileParts[0]).toEqual([
    { name: "committed.png", mimeType: "image/png", bytes: Array.from(TEST_PNG) },
  ]);
  const committedEntries = await listEntries(request, fund.fundId);
  expect(committedEntries.items).toHaveLength(1);
  const originalEntryIds = committedEntries.items.map((entry) => entry.id);
  const originalReceiptId = committedEntries.items[0]?.receiptId;
  if (!originalReceiptId) throw new Error("Committed receipt is missing");
  expect(await receiptBytes(request, fund.fundId, originalReceiptId)).toEqual(TEST_PNG);
  expect((await getFund(request, fund.fundId)).balanceYen).toBe("-630");
  await page.getByRole("button", { name: "同じ内容で結果を確認" }).click();
  await expect(page.getByRole("status").filter({ hasText: "記帳しました" })).toBeVisible();
  await expect(page.locator("article.record-row")).toHaveCount(1);
  trace = await page.evaluate(() => {
    const tracedWindow = window as Window & { __e2eFetchTrace?: FetchTrace };
    if (!tracedWindow.__e2eFetchTrace) throw new Error("Response-loss trace is missing");
    return tracedWindow.__e2eFetchTrace;
  });
  expect(trace.calls).toBe(2);
  expect(trace.textParts[1]).toEqual(trace.textParts[0]);
  expect(scan.calls()).toBe(1);
  expect(trace.fileParts[1]).toEqual(trace.fileParts[0]);
  const retryEnvelope = trace.retryResponse as
    | { json?: { entryIds?: string[]; receiptId?: string | null } }
    | undefined;
  expect(retryEnvelope?.json?.entryIds).toEqual(originalEntryIds);
  expect(retryEnvelope?.json?.receiptId).toBe(originalReceiptId);
  const entries = await listEntries(request, fund.fundId);
  expect(entries.items).toHaveLength(1);
  expect(entries.items.map((entry) => entry.id)).toEqual(originalEntryIds);
  expect(entries.items[0]?.description).toBe("committed once");
  expect(entries.items[0]?.receiptId).toBe(originalReceiptId);
  expect(await getFund(request, fund.fundId)).toMatchObject({
    incomeYen: "0",
    expenseYen: "630",
    balanceYen: "-630",
  });
  const receiptId = await firstReceipt(request, fund.fundId);
  expect(receiptId).toBe(originalReceiptId);
  expect(await receiptBytes(request, fund.fundId, receiptId)).toEqual(TEST_PNG);
});
