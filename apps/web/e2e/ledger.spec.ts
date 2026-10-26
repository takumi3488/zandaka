import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { E2E_BASE_URL, E2E_MASTER_KEY } from "./constants";
import {
  createEntries,
  createTestFund,
  listEntries,
  openFund,
  rpc,
  type Entry,
  type EntryInput,
} from "./helpers";

async function addManualEntry(page: Page, entry: EntryInput): Promise<void> {
  await page.getByLabel("区分").selectOption(entry.kind);
  await page.getByLabel("日付").fill(entry.occurredOn);
  await page.getByLabel("金額（円）").fill(String(entry.amountYen));
  await page.getByLabel("内容").fill(entry.description);
  await page.getByRole("button", { name: "手入力で記帳する" }).click();
  await expect(page.getByRole("status").filter({ hasText: "記帳しました" })).toBeVisible();
}

async function seedEntries(
  request: APIRequestContext,
  fundId: string,
  count: number,
): Promise<void> {
  for (let start = 0; start < count; start += 50) {
    const entries = Array.from({ length: Math.min(50, count - start) }, (_, offset) => ({
      occurredOn: "2026-10-01",
      kind: "expense" as const,
      amountYen: 1,
      description: `page-entry-${String(start + offset + 1).padStart(2, "0")}`,
    }));
    await createEntries(request, fundId, entries);
  }
}

async function refocusPage(page: Page): Promise<void> {
  const listResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/entries/list") && response.request().method() === "POST",
  );
  await page.evaluate(() => {
    if (document.visibilityState !== "visible") {
      throw new Error("Expected the ledger page to be visible before refetching");
    }
    window.dispatchEvent(new Event("visibilitychange"));
  });
  expect((await listResponse).ok()).toBe(true);
}

test("admin issuance, manual ledger, and shared URL keep funds isolated", async ({
  page,
  browser,
  request,
}) => {
  await page.goto(`${E2E_BASE_URL}/admin`);
  await page.getByRole("heading", { level: 1, name: "共有する資金を作成" }).waitFor({
    state: "visible",
  });
  await page.getByLabel("資金名").fill("部費 E2E");
  await page.getByLabel("開始残高（円）").fill("10000");
  await page.getByLabel("マスターキー").fill("incorrect-key");
  const deniedResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/funds/create") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "共有URLを発行する" }).click();
  const deniedResponse = await deniedResponsePromise;
  expect(deniedResponse.status()).toBe(401);
  expect(await deniedResponse.text()).not.toContain(E2E_MASTER_KEY);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "共有URL", exact: true })).toHaveCount(0);

  await page.getByLabel("マスターキー").fill(E2E_MASTER_KEY);
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/funds/create") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "共有URLを発行する" }).click();
  const createResponse = await createResponsePromise;
  expect(await createResponse.text()).not.toContain(E2E_MASTER_KEY);

  const shareInput = page.getByRole("textbox", { name: "共有URL", exact: true });
  await expect(shareInput).toHaveValue(
    /\/f\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  const shareUrl = await shareInput.inputValue();
  expect(shareUrl).not.toContain(E2E_MASTER_KEY);
  expect(new URL(shareUrl).pathname).toMatch(
    /^\/f\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  await expect(page.getByLabel("マスターキー")).toHaveValue("");
  const storedValues = await page.evaluate(() =>
    JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }),
  );
  expect(storedValues).not.toContain(E2E_MASTER_KEY);

  const otherFund = await createTestFund(request, "isolated");
  await createEntries(request, otherFund.fundId, [
    { occurredOn: "2026-10-02", kind: "income", amountYen: 99, description: "other-fund-only" },
  ]);

  await page.getByRole("link", { name: "台帳を開く" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "部費 E2E" })).toBeVisible();
  await addManualEntry(page, {
    occurredOn: "2026-10-01",
    kind: "income",
    amountYen: 2000,
    description: "会費",
  });
  await addManualEntry(page, {
    occurredOn: "2026-10-02",
    kind: "expense",
    amountYen: 350,
    description: "文具",
  });
  const summary = page.getByRole("region", { name: "残高の概要" });
  await expect(summary).toContainText("2,000円");
  await expect(summary).toContainText("350円");
  await expect(summary).toContainText("11,650円");
  await expect(page.locator("article.record-row")).toHaveCount(2);
  await expect(
    page.locator("article.record-row").filter({ hasText: "other-fund-only" }),
  ).toHaveCount(0);

  await page.reload();
  await expect(summary).toContainText("11,650円");
  const collaboratorContext = await browser.newContext();
  try {
    const collaborator = await collaboratorContext.newPage();
    await collaborator.goto(shareUrl);
    await expect(collaborator.getByRole("heading", { level: 1, name: "部費 E2E" })).toBeVisible();
    await expect(collaborator.getByRole("region", { name: "残高の概要" })).toContainText(
      "11,650円",
    );
    await expect(collaborator.locator("article.record-row")).toHaveCount(2);
    await expect(
      collaborator.locator("article.record-row").filter({ hasText: "other-fund-only" }),
    ).toHaveCount(0);
  } finally {
    await collaboratorContext.close();
  }
});

test("version conflicts preserve edits and require confirmation before deleting", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "conflicts");
  await openFund(page, fund);
  await addManualEntry(page, {
    occurredOn: "2026-10-01",
    kind: "expense",
    amountYen: 100,
    description: "original record",
  });
  let [entry] = (await listEntries(request, fund.fundId)).items;
  expect(entry).toBeDefined();

  let row = page.locator("article.record-row").filter({ hasText: "original record" });
  await row.getByRole("button", { name: "編集" }).click();
  const editor = page.locator("form.record-editor");
  const editorDescription = editor.getByRole("textbox", { name: "内容", exact: true });
  await editorDescription.fill("my unsaved edit");
  const remoteEntry: EntryInput = {
    occurredOn: entry!.occurredOn,
    kind: "expense",
    amountYen: 125,
    description: "another person's edit",
  };
  entry = await rpc<Entry>(request, "entries/update", {
    fundId: fund.fundId,
    entryId: entry!.id,
    version: entry!.version,
    entry: remoteEntry,
  });
  const editResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/entries/update") && response.request().method() === "POST",
  );
  await editor.getByRole("button", { name: "変更を保存する" }).click();
  const editResponse = await editResponsePromise;
  expect(editResponse.status()).toBe(409);
  const editConflict = page.getByRole("region", { name: "記録の競合内容" });
  await expect(editConflict).toContainText("another person's edit");
  await expect(editorDescription).toHaveValue("my unsaved edit");
  expect((await listEntries(request, fund.fundId)).items[0]).toMatchObject(entry!);
  await editConflict.getByRole("button", { name: "最新内容で編集し直す" }).click();
  await expect(editorDescription).toHaveValue("another person's edit");
  await editorDescription.fill("accepted after refresh");
  await editor.getByRole("button", { name: "変更を保存する" }).click();
  await expect(
    page.locator("article.record-row").filter({ hasText: "accepted after refresh" }),
  ).toBeVisible();

  row = page.locator("article.record-row").filter({ hasText: "accepted after refresh" });
  await row.getByRole("button", { name: "削除" }).click();
  const confirmation = page.locator(".delete-confirmation");
  const [current] = (await listEntries(request, fund.fundId)).items;
  expect(current).toBeDefined();
  const latest = await rpc<Entry>(request, "entries/update", {
    fundId: fund.fundId,
    entryId: current!.id,
    version: current!.version,
    entry: {
      occurredOn: current!.occurredOn,
      kind: current!.kind,
      amountYen: 200,
      description: "latest before delete",
    },
  });
  await confirmation.getByRole("button", { name: "削除を確定する" }).click();
  await expect(confirmation.getByRole("alert")).toBeVisible();
  await expect(confirmation).toContainText(latest.description);
  await confirmation.getByRole("button", { name: "最新内容を確認して削除を続ける" }).click();
  await confirmation.getByRole("button", { name: "削除を確定する" }).click();
  await expect(page.locator("article.record-row")).toHaveCount(0);
  expect((await listEntries(request, fund.fundId)).items).toHaveLength(0);
});

test("an edited record stays open when another user moves it off the current page", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "off-page-conflict");
  await seedEntries(request, fund.fundId, 51);
  const firstPage = await listEntries(request, fund.fundId);
  expect(firstPage.items).toHaveLength(50);
  expect(firstPage.nextCursor).not.toBeNull();
  const secondPage = await listEntries(request, fund.fundId, firstPage.nextCursor!);
  expect(secondPage.items).toHaveLength(1);
  const offPageEntry = secondPage.items[0]!;

  await openFund(page, fund);
  await page.getByRole("button", { name: "次の50件" }).click();
  const row = page.locator("article.record-row").filter({ hasText: offPageEntry.description });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "編集" }).click();
  const editor = page.locator("form.record-editor");
  const editorDescription = editor.getByRole("textbox", { name: "内容", exact: true });
  await editorDescription.fill("draft kept after move");

  const latestEntry = await rpc<Entry>(request, "entries/update", {
    fundId: fund.fundId,
    entryId: offPageEntry.id,
    version: offPageEntry.version,
    entry: {
      occurredOn: "2026-10-25",
      kind: offPageEntry.kind,
      amountYen: offPageEntry.amountYen,
      description: "moved to newer date",
    },
  });
  await refocusPage(page);
  await expect(row).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(editorDescription).toHaveValue("draft kept after move");

  const editResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/entries/update") && response.request().method() === "POST",
  );
  await editor.getByRole("button", { name: "変更を保存する" }).click();
  const editResponse = await editResponsePromise;
  expect(editResponse.status()).toBe(409);
  const editConflict = page.getByRole("region", { name: "記録の競合内容" });
  await expect(editConflict).toContainText(latestEntry.description);
  await expect(editorDescription).toHaveValue("draft kept after move");
  const unchangedRemoteEntry = (await listEntries(request, fund.fundId)).items.find(
    ({ id }) => id === offPageEntry.id,
  );
  expect(unchangedRemoteEntry).toEqual(latestEntry);
  expect((await listEntries(request, fund.fundId)).items).toHaveLength(50);
});

test("paging stays complete after a newer record is inserted", async ({ page, request }) => {
  const fund = await createTestFund(request, "paging");
  await seedEntries(request, fund.fundId, 51);
  await openFund(page, fund);
  await expect(page.locator("article.record-row")).toHaveCount(50);
  await page.getByRole("button", { name: "次の50件" }).click();
  await expect(page.locator("article.record-row")).toHaveCount(1);
  await page.getByRole("button", { name: "前の50件" }).click();
  await expect(page.locator("article.record-row")).toHaveCount(50);

  await createEntries(request, fund.fundId, [
    {
      occurredOn: "2026-10-26",
      kind: "income",
      amountYen: 1,
      description: "inserted after page walk",
    },
  ]);
  await refocusPage(page);
  await expect(page.locator("article.record-row").first()).toContainText(
    "inserted after page walk",
  );
  const firstPageRows = await page.locator("article.record-row").allTextContents();
  expect(firstPageRows).toHaveLength(50);

  await page.getByRole("button", { name: "次の50件" }).click();
  await expect(page.locator("article.record-row")).toHaveCount(2);
  const secondPageRows = await page.locator("article.record-row").allTextContents();
  const displayedRows = [...firstPageRows, ...secondPageRows];

  const apiEntries: Entry[] = [];
  let apiPage = await listEntries(request, fund.fundId);
  while (true) {
    apiEntries.push(...apiPage.items);
    if (!apiPage.nextCursor) break;
    apiPage = await listEntries(request, fund.fundId, apiPage.nextCursor);
  }
  const apiIds = apiEntries.map(({ id }) => id);
  const apiDescriptions = apiEntries.map(({ description }) => description);
  expect(apiEntries).toHaveLength(52);
  expect(new Set(apiIds).size).toBe(52);
  expect(new Set(apiDescriptions).size).toBe(52);

  const displayedDescriptions = displayedRows.map((rowText) => {
    const matches = apiEntries.filter(({ description }) => rowText.includes(description));
    expect(matches).toHaveLength(1);
    return matches[0]!.description;
  });
  expect(new Set(displayedDescriptions).size).toBe(52);
  expect([...displayedDescriptions].sort()).toEqual([...apiDescriptions].sort());
});

test("editing and deleting a cached second page refreshes it before revisiting", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "cached-page");
  await seedEntries(request, fund.fundId, 52);
  const firstPage = await listEntries(request, fund.fundId);
  expect(firstPage.items).toHaveLength(50);
  expect(firstPage.nextCursor).not.toBeNull();
  const secondPage = await listEntries(request, fund.fundId, firstPage.nextCursor!);
  expect(secondPage.items).toHaveLength(2);
  const original = secondPage.items[0]!;
  const updatedDescription = "updated cached second-page record";

  await openFund(page, fund);
  await page.getByRole("button", { name: "次の50件" }).click();
  const originalRow = page.locator("article.record-row").filter({ hasText: original.description });
  await expect(originalRow).toBeVisible();
  await originalRow.getByRole("button", { name: "編集" }).click();
  const editor = page.locator("form.record-editor");
  await editor.getByRole("textbox", { name: "内容", exact: true }).fill(updatedDescription);
  const updateResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/entries/update") && response.request().method() === "POST",
  );
  await editor.getByRole("button", { name: "変更を保存する" }).click();
  expect((await updateResponsePromise).ok()).toBe(true);
  await expect(page.getByText("ページ 1", { exact: true })).toBeVisible();

  const updatedEntry = (await listEntries(request, fund.fundId, firstPage.nextCursor!)).items.find(
    ({ id }) => id === original.id,
  );
  expect(updatedEntry).toMatchObject({
    id: original.id,
    version: original.version + 1,
    description: updatedDescription,
  });

  const editedPageResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/entries/list") && response.request().method() === "POST",
    { timeout: 5_000 },
  );
  await page.getByRole("button", { name: "次の50件" }).click();
  expect((await editedPageResponsePromise).ok()).toBe(true);
  const updatedRow = page.locator("article.record-row").filter({ hasText: updatedDescription });
  await expect(updatedRow).toBeVisible();
  await expect(page.locator("article.record-row")).toHaveCount(2);

  await updatedRow.getByRole("button", { name: "削除" }).click();
  const confirmation = page.locator(".delete-confirmation");
  const deleteResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/entries/delete") && response.request().method() === "POST",
  );
  await confirmation.getByRole("button", { name: "削除を確定する" }).click();
  expect((await deleteResponsePromise).ok()).toBe(true);
  await expect(page.getByText("ページ 1", { exact: true })).toBeVisible();

  const remainingPage = await listEntries(request, fund.fundId, firstPage.nextCursor!);
  expect(remainingPage.items).toHaveLength(1);
  expect(remainingPage.items.some(({ id }) => id === original.id)).toBe(false);

  const deletedPageResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/entries/list") && response.request().method() === "POST",
    { timeout: 5_000 },
  );
  await page.getByRole("button", { name: "次の50件" }).click();
  expect((await deletedPageResponsePromise).ok()).toBe(true);
  await expect(page.locator("article.record-row")).toHaveCount(1);
  await expect(
    page.locator("article.record-row").filter({ hasText: updatedDescription }),
  ).toHaveCount(0);
  await expect(
    page.locator("article.record-row").filter({ hasText: remainingPage.items[0]!.description }),
  ).toBeVisible();
});
