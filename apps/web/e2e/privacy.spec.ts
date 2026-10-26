import { expect, test, type APIResponse } from "@playwright/test";

import { E2E_BASE_URL } from "./constants";
import {
  createTestFund,
  getFund,
  installScanFixture,
  listEntries,
  openFund,
  pngFile,
  TEST_PNG,
} from "./helpers";

async function expectPrivateHeaders(response: APIResponse, label: string): Promise<void> {
  expect(response.status(), `${label} should be accessible`).toBe(200);
  const headers = response.headers();
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-robots-tag"]).toBe("noindex,nofollow");
  expect(headers["x-frame-options"]).toBe("DENY");
}

test("private app responses and receipt reads enforce privacy boundaries", async ({
  page,
  request,
}) => {
  const fund = await createTestFund(request, "privacy-owner");
  const otherFund = await createTestFund(request, "privacy-other");
  const scan = await installScanFixture(
    page,
    [
      {
        occurredOn: "2026-10-26",
        kind: "expense",
        amountYen: 123,
        description: "privacy boundary receipt",
      },
    ],
    ["E2E scan transport fixture"],
  );

  await openFund(page, fund);
  const fileInput = page.locator('input[type="file"]');
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles(pngFile());
  await expect(page.locator("article.record-row")).toHaveCount(1);
  expect(scan.calls()).toBe(1);

  const { items } = await listEntries(request, fund.fundId);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    description: "privacy boundary receipt",
    receiptId: expect.any(String),
  });
  const receiptId = items[0]!.receiptId;
  expect(receiptId).not.toBeNull();

  const adminResponse = await request.get(`${E2E_BASE_URL}/admin`);
  await expectPrivateHeaders(adminResponse, "Admin HTML");

  const fundResponse = await request.get(fund.url);
  await expectPrivateHeaders(fundResponse, "Fund HTML");

  const rpcResponse = await request.post(`${E2E_BASE_URL}/rpc/funds/get`, {
    data: { json: { fundId: fund.fundId } },
  });
  await expectPrivateHeaders(rpcResponse, "Fund RPC");
  expect(await rpcResponse.json()).toMatchObject({ json: { id: fund.fundId } });
  expect((await getFund(request, otherFund.fundId)).id).toBe(otherFund.fundId);

  const receiptUrl = `${E2E_BASE_URL}/api/funds/${fund.fundId}/receipts/${receiptId}`;
  const receiptResponse = await request.get(receiptUrl);
  await expectPrivateHeaders(receiptResponse, "Private receipt");
  const receiptHeaders = receiptResponse.headers();
  expect(receiptHeaders["content-type"]).toBe("image/png");
  expect(receiptHeaders["content-disposition"]).toBe("inline");
  expect(receiptHeaders["x-content-type-options"]).toBe("nosniff");
  expect(await receiptResponse.body()).toEqual(TEST_PNG);

  const crossFundReceiptResponse = await request.get(
    receiptUrl.replace(`/funds/${fund.fundId}/`, `/funds/${otherFund.fundId}/`),
  );
  expect(crossFundReceiptResponse.status()).toBe(404);

  const malformedFundReceiptResponse = await request.get(
    receiptUrl.replace(`/funds/${fund.fundId}/`, "/funds/not-a-valid-uuid/"),
  );
  expect(malformedFundReceiptResponse.status()).toBe(404);
});
