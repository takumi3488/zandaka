import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { entryBatches, entries, funds, receipts } from "@zandaka/db/schema/index";
import type { AppRouterClient } from "./routers/index";
import { cleanupReceipts, getReceipt } from "./receipt-storage";
import { entrySchema } from "./validation";
import { createTestFixture, file, makeEntry, testMasterKey, uuid } from "./test-fixture";

const DAY = 86_400_000;
function deferred<T>() {
  return Promise.withResolvers<T>();
}

function gateFirstPut(bucket: R2Bucket) {
  const entered = deferred<void>();
  const released = deferred<void>();
  let firstPut = true;
  const gatedBucket = new Proxy(bucket, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (property === "put" && typeof member === "function") {
        return (...args: Parameters<R2Bucket["put"]>) => {
          const result = Reflect.apply(member, target, args) as Promise<R2Object>;
          if (!firstPut) return result;
          firstPut = false;
          return result.then(async (object) => {
            entered.resolve();
            await released.promise;
            return object;
          });
        };
      }
      return typeof member === "function" ? member.bind(target) : member;
    },
  }) as R2Bucket;
  return {
    bucket: gatedBucket,
    entered: entered.promise,
    release: () => released.resolve(),
  };
}
function codeOf(error: unknown) {
  assert.ok(error !== null && typeof error === "object" && "code" in error);
  assert.equal(typeof error.code, "string");
  return error.code;
}

function messageOf(error: unknown): string {
  assert.ok(
    error !== null &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string",
  );
  return error.message;
}

function latestEntry(error: unknown) {
  assert.ok(error !== null && typeof error === "object" && "data" in error);
  const data = error.data;
  assert.ok(data !== null && typeof data === "object" && "latest" in data);
  return entrySchema.parse(data.latest);
}

function hasCode(code: string) {
  return (error: unknown) => codeOf(error) === code;
}

async function createFund(client: AppRouterClient, openingBalanceYen = 0) {
  return client.funds.create({
    masterKey: testMasterKey,
    name: "部費",
    openingBalanceYen,
  });
}

async function insertReceipt(
  db: Parameters<typeof getReceipt>[0],
  fundId: string,
  state: "uploading" | "ready" | "deleting",
  createdAt = Date.now(),
) {
  const id = uuid();
  const objectKey = `${fundId}/${id}`;
  await db
    .insert(receipts)
    .values({
      id,
      fundId,
      objectKey,
      mimeType: "image/jpeg",
      sizeBytes: 4,
      state,
      createdAt,
    })
    .run();
  return { id, objectKey };
}

test("fund creation protects the master key and ledger arithmetic stays exact", async () => {
  const fixture = await createTestFixture();
  try {
    await assert.rejects(
      fixture.client.funds.create({ masterKey: "wrong", name: "bad", openingBalanceYen: 0 }),
      hasCode("UNAUTHORIZED"),
    );
    const unset = await createTestFixture({ masterKey: null });
    try {
      await assert.rejects(
        unset.client.funds.create({ masterKey: testMasterKey, name: "bad", openingBalanceYen: 0 }),
        hasCode("SERVICE_UNAVAILABLE"),
      );
      assert.deepEqual(await unset.db.select().from(funds), []);
    } finally {
      await unset.close();
    }
    assert.deepEqual(await fixture.db.select().from(funds), []);

    const { fundId } = await createFund(fixture.client, 10_000);
    assert.match(fundId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const income = await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [makeEntry({ kind: "income", amountYen: 2_000 })],
    });
    const expense = await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [makeEntry({ occurredOn: "2026-10-02", kind: "expense", amountYen: 350 })],
    });
    let summary = await fixture.client.funds.get({ fundId });
    assert.deepEqual(
      [summary.incomeYen, summary.expenseYen, summary.balanceYen],
      ["2000", "350", "11650"],
    );

    const updated = await fixture.client.entries.update({
      fundId,
      entryId: expense.entryIds[0]!,
      version: 1,
      entry: makeEntry({ occurredOn: "2026-10-02", kind: "expense", amountYen: 500 }),
    });
    assert.equal(updated.version, 2);
    summary = await fixture.client.funds.get({ fundId });
    assert.deepEqual([summary.expenseYen, summary.balanceYen], ["500", "11500"]);

    await fixture.client.entries.delete({ fundId, entryId: income.entryIds[0]!, version: 1 });
    summary = await fixture.client.funds.get({ fundId });
    assert.deepEqual(
      [summary.incomeYen, summary.expenseYen, summary.balanceYen],
      ["0", "500", "9500"],
    );

    await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [makeEntry({ occurredOn: "2026-10-03", kind: "expense", amountYen: 15_000 })],
    });
    assert.equal((await fixture.client.funds.get({ fundId })).balanceYen, "-5500");

    const beforeInvalid = await fixture.db.select().from(entries);
    for (const entry of [
      makeEntry({ amountYen: 0 }),
      makeEntry({ amountYen: -1 }),
      makeEntry({ amountYen: 1.5 }),
      makeEntry({ amountYen: Number.NaN }),
      makeEntry({ amountYen: Number.POSITIVE_INFINITY }),
      makeEntry({ amountYen: 1_000_000_000_000 }),
      makeEntry({ occurredOn: "2026-02-30" }),
    ]) {
      await assert.rejects(
        fixture.client.entries.createBatch({ fundId, submissionId: uuid(), entries: [entry] }),
        hasCode("BAD_REQUEST"),
      );
    }
    for (const openingBalanceYen of [1_000_000_000_000, -1_000_000_000_000]) {
      await assert.rejects(
        fixture.client.funds.create({
          masterKey: testMasterKey,
          name: "out of range",
          openingBalanceYen,
        }),
        hasCode("BAD_REQUEST"),
      );
    }
    assert.equal((await fixture.db.select().from(entries)).length, beforeInvalid.length);
    assert.equal((await fixture.db.select().from(funds)).length, 1);

    const maximum = await createFund(fixture.client, 999_999_999_999);
    await fixture.client.entries.createBatch({
      fundId: maximum.fundId,
      submissionId: uuid(),
      entries: [makeEntry({ amountYen: 999_999_999_999 })],
    });
    assert.equal(
      (await fixture.client.funds.get({ fundId: maximum.fundId })).balanceYen,
      "1999999999998",
    );
    const boundary = await createFund(fixture.client, -999_999_999_999);
    assert.equal(
      (await fixture.client.funds.get({ fundId: boundary.fundId })).balanceYen,
      "-999999999999",
    );
  } finally {
    await fixture.close();
  }
});

test("fund totals remain exact above Number.MAX_SAFE_INTEGER", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client, 10_000);
    const submissionId = uuid();
    const rowCount = 9_009;
    const entryIds = Array.from(
      { length: rowCount },
      (_, index) => `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    );
    const createdAt = Date.now();
    await fixture.db.insert(entryBatches).values({
      fundId,
      submissionId,
      requestHash: "0".repeat(64),
      entryIds: JSON.stringify(entryIds),
      receiptId: null,
      createdAt,
    });

    const seeded = await fixture.d1
      .prepare(
        `WITH RECURSIVE seed(n) AS (
          SELECT 0
          UNION ALL
          SELECT n + 1 FROM seed WHERE n < 9008
        )
        INSERT INTO entries (
          id, fund_id, submission_id, occurred_on, kind, amount_yen,
          description, receipt_id, version, created_at, updated_at
        )
        SELECT
          printf('00000000-0000-4000-8000-%012x', n + 1),
          ?1, ?2, '2026-10-01', 'income',
          CASE WHEN n < 9008 THEN 999999999999 ELSE 1 END,
          'bulk aggregate boundary', NULL, 1, ?3, ?3
        FROM seed`,
      )
      .bind(fundId, submissionId, createdAt)
      .run();
    assert.equal(seeded.meta.changes, rowCount);

    await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [makeEntry({ occurredOn: "2026-10-02", kind: "expense", amountYen: 350 })],
    });

    const summary = await fixture.client.funds.get({ fundId });
    assert.deepEqual(
      [summary.incomeYen, summary.expenseYen, summary.balanceYen],
      ["9007999999990993", "350", "9008000000000643"],
    );
    assert.ok(BigInt(summary.incomeYen) > BigInt(Number.MAX_SAFE_INTEGER));
  } finally {
    await fixture.close();
  }
});

test("batch creation handles 50 entries, parallel idempotency and deleted replay", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client);
    await assert.rejects(
      fixture.client.entries.createBatch({ fundId, submissionId: uuid(), entries: [] }),
      hasCode("BAD_REQUEST"),
    );
    await assert.rejects(
      fixture.client.entries.createBatch({
        fundId,
        submissionId: uuid(),
        entries: Array.from({ length: 51 }, () => makeEntry()),
      }),
      hasCode("BAD_REQUEST"),
    );
    const submissionId = uuid();
    const payload = {
      fundId,
      submissionId,
      entries: Array.from({ length: 50 }, (_, i) =>
        makeEntry({ occurredOn: "2026-10-01", amountYen: i + 1, description: `行${i}` }),
      ),
    };
    const results = await Promise.all([
      fixture.client.entries.createBatch(payload),
      fixture.client.entries.createBatch(payload),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].entryIds.length, 50);
    assert.equal((await fixture.db.select().from(entries)).length, 50);
    assert.equal((await fixture.db.select().from(entryBatches)).length, 1);

    const page = await fixture.client.entries.list({ fundId });
    assert.equal(page.items.length, 50);
    assert.equal(page.nextCursor, null);
    await assert.rejects(
      fixture.client.entries.createBatch({ ...payload, entries: [makeEntry({ amountYen: 999 })] }),
      hasCode("CONFLICT"),
    );

    await fixture.client.entries.delete({ fundId, entryId: results[0].entryIds[0]!, version: 1 });
    const replay = await fixture.client.entries.createBatch(payload);
    assert.deepEqual(replay, results[0]);
    assert.equal((await fixture.db.select().from(entries)).length, 49);
    const imageEntries = [makeEntry({ description: "image batch" })];
    const imageSubmissionId = uuid();
    await fixture.client.entries.createBatch({
      fundId,
      submissionId: imageSubmissionId,
      entries: imageEntries,
      receipt: file(),
    });
    await assert.rejects(
      fixture.client.entries.createBatch({
        fundId,
        submissionId: imageSubmissionId,
        entries: imageEntries,
        receipt: file(new Uint8Array([0xff, 0xd8, 0xff, 0xd7])),
      }),
      hasCode("CONFLICT"),
    );
    assert.equal((await fixture.db.select().from(entries)).length, 50);
    assert.equal((await fixture.db.select().from(entryBatches)).length, 2);
    assert.equal((await fixture.db.select().from(receipts)).length, 1);
  } finally {
    await fixture.close();
  }
});

test("entry operations are fund-scoped and optimistic conflicts return the latest row", async () => {
  const fixture = await createTestFixture();
  try {
    const first = await createFund(fixture.client);
    const second = await createFund(fixture.client);
    const created = await fixture.client.entries.createBatch({
      fundId: first.fundId,
      submissionId: uuid(),
      entries: [makeEntry()],
    });
    const entryId = created.entryIds[0]!;
    await assert.rejects(
      fixture.client.entries.update({
        fundId: second.fundId,
        entryId,
        version: 1,
        entry: makeEntry({ description: "cross-fund" }),
      }),
      hasCode("NOT_FOUND"),
    );
    await assert.rejects(
      fixture.client.entries.delete({ fundId: second.fundId, entryId, version: 1 }),
      hasCode("NOT_FOUND"),
    );

    const listed = await fixture.client.entries.list({ fundId: first.fundId });
    assert.equal(listed.items.length, 1);
    const updates = await Promise.allSettled([
      fixture.client.entries.update({
        fundId: first.fundId,
        entryId,
        version: 1,
        entry: makeEntry({ amountYen: 2200, description: "先着" }),
      }),
      fixture.client.entries.update({
        fundId: first.fundId,
        entryId,
        version: 1,
        entry: makeEntry({ amountYen: 3300, description: "後着" }),
      }),
    ]);
    assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1);
    const stale = updates.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )!;
    assert.equal(codeOf(stale.reason), "CONFLICT");
    assert.equal(latestEntry(stale.reason).version, 2);

    const pageSeed = await fixture.client.entries.createBatch({
      fundId: first.fundId,
      submissionId: uuid(),
      entries: Array.from({ length: 50 }, (_, i) =>
        makeEntry({
          occurredOn: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
          description: `page ${i}`,
        }),
      ),
    });
    const newestBatch = await fixture.client.entries.createBatch({
      fundId: first.fundId,
      submissionId: uuid(),
      entries: [makeEntry({ occurredOn: "2027-01-01", description: "moves off page" })],
    });
    const initial = await fixture.client.entries.list({ fundId: first.fundId });
    assert.equal(initial.items[0]?.id, newestBatch.entryIds[0]);
    assert.equal(initial.items.length, 50);
    assert.ok(initial.nextCursor);
    const nextPage = await fixture.client.entries.list({
      fundId: first.fundId,
      cursor: initial.nextCursor,
    });
    assert.equal(nextPage.items.length, 2);
    const movingId = newestBatch.entryIds[0]!;
    assert.ok(initial.items.some((entry) => entry.id === movingId));
    const moving = initial.items.find((entry) => entry.id === movingId)!;
    const moved = await fixture.client.entries.update({
      fundId: first.fundId,
      entryId: movingId,
      version: moving.version,
      entry: makeEntry({ occurredOn: "2020-01-01", description: "moved" }),
    });
    assert.equal(moved.version, 2);
    const afterMove = await fixture.client.entries.list({ fundId: first.fundId });
    assert.equal(
      afterMove.items.some((entry) => entry.id === movingId),
      false,
    );

    const staleUpdate = await fixture.client.entries
      .update({
        fundId: first.fundId,
        entryId: movingId,
        version: moving.version,
        entry: makeEntry({ occurredOn: "2026-08-01", description: "stale" }),
      })
      .then(
        () => assert.fail("stale update should conflict"),
        (error: unknown) => error,
      );
    assert.equal(codeOf(staleUpdate), "CONFLICT");
    const latest = latestEntry(staleUpdate);
    assert.equal(latest.id, movingId);
    assert.equal(latest.occurredOn, "2020-01-01");
    await assert.rejects(
      fixture.client.entries.delete({ fundId: first.fundId, entryId: movingId, version: 1 }),
      (error: unknown) => {
        assert.equal(codeOf(error), "CONFLICT");
        assert.equal(latestEntry(error).version, 2);
        return true;
      },
    );
    assert.equal((await fixture.client.entries.list({ fundId: second.fundId })).items.length, 0);
    assert.equal(pageSeed.entryIds.length, 50);
    await assert.rejects(
      fixture.client.funds.get({ fundId: "not-a-uuid" }),
      hasCode("BAD_REQUEST"),
    );
    await assert.rejects(fixture.client.funds.get({ fundId: uuid() }), hasCode("NOT_FOUND"));
    await assert.rejects(fixture.client.entries.list({ fundId: uuid() }), hasCode("NOT_FOUND"));
  } finally {
    await fixture.close();
  }
});

test("receipt lifecycle retains shared evidence until the final entry and cleans stale uploads", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client);
    const { fundId: otherFund } = await createFund(fixture.client);
    const shared = await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [
        makeEntry({ description: "first" }),
        makeEntry({ occurredOn: "2026-10-02", description: "second" }),
      ],
      receipt: file(),
    });
    assert.ok(shared.receiptId);
    const stored = await getReceipt(fixture.db, fixture.receipts, fundId, shared.receiptId!);
    assert.equal(stored.httpMetadata?.contentType, "image/jpeg");
    assert.deepEqual(
      [...new Uint8Array(await new Response(stored.body).arrayBuffer())],
      [0xff, 0xd8, 0xff, 0xd9],
    );
    await assert.rejects(
      getReceipt(fixture.db, fixture.receipts, otherFund, shared.receiptId!),
      hasCode("NOT_FOUND"),
    );
    await cleanupReceipts(fixture.db, fixture.receipts, Date.now() + DAY);
    assert.ok(await getReceipt(fixture.db, fixture.receipts, fundId, shared.receiptId!));

    await fixture.client.entries.delete({ fundId, entryId: shared.entryIds[0]!, version: 1 });
    assert.ok(await getReceipt(fixture.db, fixture.receipts, fundId, shared.receiptId!));
    await fixture.client.entries.delete({ fundId, entryId: shared.entryIds[1]!, version: 1 });
    await assert.rejects(
      getReceipt(fixture.db, fixture.receipts, fundId, shared.receiptId!),
      hasCode("NOT_FOUND"),
    );
    assert.equal((await fixture.db.select().from(receipts)).length, 0);
    assert.equal((await fixture.receipts.list()).objects.length, 0);

    const freshId = uuid();
    const freshKey = `${otherFund}/${freshId}`;
    const freshCreatedAt = Date.now();
    await fixture.db.insert(receipts).values({
      id: freshId,
      fundId: otherFund,
      objectKey: freshKey,
      mimeType: "image/jpeg",
      sizeBytes: 4,
      state: "uploading",
      createdAt: freshCreatedAt,
    });
    await fixture.receipts.put(freshKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));

    const staleId = uuid();
    const staleKey = `${otherFund}/${staleId}`;
    await fixture.db.insert(receipts).values({
      id: staleId,
      fundId: otherFund,
      objectKey: staleKey,
      mimeType: "image/jpeg",
      sizeBytes: 4,
      state: "uploading",
      createdAt: freshCreatedAt - DAY - 1,
    });
    await fixture.receipts.put(staleKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const deletingId = uuid();
    const deletingKey = `${otherFund}/${deletingId}`;
    await fixture.db.insert(receipts).values({
      id: deletingId,
      fundId: otherFund,
      objectKey: deletingKey,
      mimeType: "image/jpeg",
      sizeBytes: 4,
      state: "deleting",
      createdAt: freshCreatedAt,
    });
    await fixture.receipts.put(deletingKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const failingBucket = new Proxy(fixture.receipts, {
      get(target, property) {
        if (property === "delete") {
          return async () => {
            throw new Error("simulated R2 delete failure");
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    }) as R2Bucket;
    await assert.rejects(
      cleanupReceipts(fixture.db, failingBucket, Date.now()),
      /simulated R2 delete failure/,
    );
    assert.equal(
      (await fixture.db.select().from(receipts).where(eq(receipts.id, staleId)).get())?.state,
      "deleting",
    );
    assert.equal(
      (await fixture.db.select().from(receipts).where(eq(receipts.id, deletingId)).get())?.state,
      "deleting",
    );
    assert.ok(await fixture.receipts.get(staleKey));
    assert.ok(await fixture.receipts.get(deletingKey));
    await cleanupReceipts(fixture.db, fixture.receipts, Date.now());
    assert.equal(
      (await fixture.db.select().from(receipts).where(eq(receipts.id, freshId))).length,
      1,
    );
    assert.ok(await fixture.receipts.get(freshKey));
    assert.equal(
      (await fixture.db.select().from(receipts).where(eq(receipts.id, staleId))).length,
      0,
    );
    assert.equal(await fixture.receipts.get(staleKey), null);
    assert.equal(
      (await fixture.db.select().from(receipts).where(eq(receipts.id, deletingId))).length,
      0,
    );
    assert.equal(await fixture.receipts.get(deletingKey), null);
    assert.equal(
      (await fixture.db.select().from(receipts).where(eq(receipts.id, freshId)).get())?.state,
      "uploading",
    );
  } finally {
    await fixture.close();
  }
});
test("invalid receipt formats, spoofed signatures and files above 5 MiB are rejected before persistence", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client);
    const invalidImages = [
      new File(["<svg/>"], "image.svg", { type: "image/svg+xml" }),
      new File([new Uint8Array([0xff, 0xd8, 0xff])], "spoof.png", { type: "image/png" }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" }),
    ];
    for (const image of invalidImages) {
      await assert.rejects(
        fixture.client.entries.createBatch({
          fundId,
          submissionId: uuid(),
          entries: [makeEntry()],
          receipt: image,
        }),
        hasCode("BAD_REQUEST"),
      );
    }
    assert.equal((await fixture.db.select().from(entries)).length, 0);
    assert.equal((await fixture.db.select().from(entryBatches)).length, 0);
    assert.equal((await fixture.db.select().from(receipts)).length, 0);
    assert.equal((await fixture.receipts.list()).objects.length, 0);
  } finally {
    await fixture.close();
  }
});
test("receipt scan enforces fund, image, provider-key and rate-limit boundaries without persistence", async () => {
  const fixture = await createTestFixture();
  let limitCalls = 0;
  fixture.context.scanLimit = {
    limit: async () => {
      limitCalls++;
      return { success: true };
    },
  } as RateLimit;
  try {
    const { fundId } = await createFund(fixture.client);
    await assert.rejects(
      fixture.client.receipts.scan({ fundId: uuid(), image: file() }),
      hasCode("NOT_FOUND"),
    );
    await assert.rejects(
      fixture.client.receipts.scan({
        fundId,
        image: new File(["<svg/>"], "image.svg", { type: "image/svg+xml" }),
      }),
      hasCode("BAD_REQUEST"),
    );
    assert.equal(limitCalls, 0);

    await assert.rejects(
      fixture.client.receipts.scan({ fundId, image: file() }),
      hasCode("SERVICE_UNAVAILABLE"),
    );
    assert.equal(limitCalls, 1);

    fixture.context.scanLimit = {
      limit: async () => {
        limitCalls++;
        return { success: false };
      },
    } as RateLimit;
    await assert.rejects(
      fixture.client.receipts.scan({ fundId, image: file() }),
      hasCode("TOO_MANY_REQUESTS"),
    );
    assert.equal(limitCalls, 2);
    assert.equal((await fixture.db.select().from(entries)).length, 0);
    assert.equal((await fixture.db.select().from(entryBatches)).length, 0);
    assert.equal((await fixture.db.select().from(receipts)).length, 0);
    assert.equal((await fixture.receipts.list()).objects.length, 0);
  } finally {
    await fixture.close();
  }
});
test("cleanup winning the upload race prevents a late receipt batch commit", async () => {
  const fixture = await createTestFixture();
  const gate = gateFirstPut(fixture.receipts);
  fixture.context.receipts = gate.bucket;
  let pending: Promise<unknown> | undefined;
  try {
    const { fundId } = await createFund(fixture.client);
    const request = fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [makeEntry()],
      receipt: file(),
    });
    pending = request;
    await gate.entered;
    const uploading = await fixture.db
      .select()
      .from(receipts)
      .where(eq(receipts.state, "uploading"))
      .get();
    assert.ok(uploading);

    await cleanupReceipts(fixture.db, gate.bucket, uploading.createdAt + DAY);
    assert.equal(await gate.bucket.get(uploading.objectKey), null);
    gate.release();
    await assert.rejects(request, hasCode("CONFLICT"));
    pending = undefined;
    assert.equal((await fixture.db.select().from(entries)).length, 0);
    assert.equal((await fixture.db.select().from(entryBatches)).length, 0);
    assert.equal((await fixture.db.select().from(receipts)).length, 0);
  } finally {
    gate.release();
    await pending?.catch(() => undefined);
    await fixture.close();
  }
});

test("same-submission receipt race recovers the committed IDs after cleanup removes the older upload", async () => {
  const fixture = await createTestFixture();
  const gate = gateFirstPut(fixture.receipts);
  fixture.context.receipts = gate.bucket;
  let pending: Promise<unknown> | undefined;
  try {
    const { fundId } = await createFund(fixture.client);
    const submissionId = uuid();
    const payload = { fundId, submissionId, entries: [makeEntry()], receipt: file() };
    const request = fixture.client.entries.createBatch(payload);
    pending = request;
    await gate.entered;
    const firstUpload = await fixture.db
      .select()
      .from(receipts)
      .where(eq(receipts.state, "uploading"))
      .get();
    assert.ok(firstUpload);

    const winner = await fixture.client.entries.createBatch({ ...payload, receipt: file() });
    assert.equal((await fixture.db.select().from(entries)).length, 1);
    assert.equal((await fixture.db.select().from(entryBatches)).length, 1);
    await cleanupReceipts(fixture.db, gate.bucket, firstUpload.createdAt + DAY);
    assert.equal(await gate.bucket.get(firstUpload.objectKey), null);
    gate.release();
    const recovered = await request;
    pending = undefined;
    assert.deepEqual(recovered, winner);

    const savedReceipts = await fixture.db.select().from(receipts);
    assert.equal(savedReceipts.length, 1);
    assert.equal(savedReceipts[0]!.state, "ready");
    assert.ok(winner.receiptId);
    assert.ok(await getReceipt(fixture.db, gate.bucket, fundId, winner.receiptId!));
    assert.equal((await fixture.db.select().from(entries)).length, 1);
  } finally {
    gate.release();
    await pending?.catch(() => undefined);
    await fixture.close();
  }
});
test("native scheduled cleanup handler runs against the D1 and R2 bindings", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client);
    const receiptId = uuid();
    const objectKey = `${fundId}/${receiptId}`;
    await fixture.db.insert(receipts).values({
      id: receiptId,
      fundId,
      objectKey,
      mimeType: "image/jpeg",
      sizeBytes: 4,
      state: "uploading",
      createdAt: Date.now() - DAY - 1,
    });
    await fixture.receipts.put(objectKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));

    // Runtime import keeps the sibling composite project out of this package's TS program.
    const workerUrl = new URL("../../infra/src/receipt-cleanup.ts", import.meta.url);
    const moduleValue: unknown = await import(workerUrl.href);
    assert.ok(moduleValue !== null && typeof moduleValue === "object" && "default" in moduleValue);
    const worker = moduleValue.default;
    assert.ok(
      worker !== null && typeof worker === "object" && "scheduled" in worker && "fetch" in worker,
    );
    const scheduled = worker.scheduled;
    const fetchHandler = worker.fetch;
    assert.ok(typeof scheduled === "function");
    assert.ok(typeof fetchHandler === "function");

    await Reflect.apply(scheduled, worker, [{}, { DB: fixture.d1, RECEIPTS: fixture.receipts }]);
    const response: unknown = await Reflect.apply(fetchHandler, worker, []);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 404);
    assert.equal(
      (await fixture.db.select().from(receipts).where(eq(receipts.id, receiptId))).length,
      0,
    );
    assert.equal(await fixture.receipts.get(objectKey), null);
  } finally {
    await fixture.close();
  }
});

test("keyset pagination keeps tied rows stable when a newer row is inserted between pages", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client);
    const tiedTimestamp = 1_700_000_000_000;
    const firstBatch = await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: Array.from({ length: 50 }, (_, index) => makeEntry({ description: `tie-${index}` })),
    });
    const secondBatch = await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: Array.from({ length: 10 }, (_, index) =>
        makeEntry({ description: `tie-extra-${index}` }),
      ),
    });
    const originalIds = [...firstBatch.entryIds, ...secondBatch.entryIds];
    await fixture.db
      .update(entries)
      .set({ createdAt: tiedTimestamp })
      .where(eq(entries.fundId, fundId))
      .run();
    const expectedIds = [...originalIds].sort((left, right) =>
      left < right ? 1 : left > right ? -1 : 0,
    );

    const firstPage = await fixture.client.entries.list({ fundId });
    assert.equal(firstPage.items.length, 50);
    assert.deepEqual(
      firstPage.items.map((entry) => entry.id),
      expectedIds.slice(0, 50),
    );
    assert.deepEqual(firstPage.nextCursor, {
      occurredOn: firstPage.items[49]!.occurredOn,
      createdAt: tiedTimestamp,
      id: expectedIds[49],
    });

    const inserted = await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [makeEntry({ description: "newer between pages" })],
    });
    const afterInsert = await fixture.client.entries.list({
      fundId,
      cursor: firstPage.nextCursor!,
    });
    assert.deepEqual(
      afterInsert.items.map((entry) => entry.id),
      expectedIds.slice(50),
    );
    assert.equal(afterInsert.nextCursor, null);
    const traversedIds = [...firstPage.items, ...afterInsert.items].map((entry) => entry.id);
    assert.equal(new Set(traversedIds).size, 60);
    assert.deepEqual([...traversedIds].sort(), [...expectedIds].sort());
    assert.ok(!traversedIds.includes(inserted.entryIds[0]!));

    const refreshedFirstPage = await fixture.client.entries.list({ fundId });
    assert.equal(refreshedFirstPage.items[0]!.id, inserted.entryIds[0]);
    assert.deepEqual(
      refreshedFirstPage.items.slice(1).map((entry) => entry.id),
      expectedIds.slice(0, 49),
    );
  } finally {
    await fixture.close();
  }
});

test("a mid-batch D1 trigger rolls back every entry but leaves uploaded evidence cleanable", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client);
    await fixture.d1
      .prepare(
        "CREATE TRIGGER fail_mid_batch BEFORE INSERT ON entries WHEN NEW.description = 'trigger-mid-batch' BEGIN SELECT RAISE(ABORT, 'private_trigger_marker'); END;",
      )
      .run();

    await assert.rejects(
      fixture.client.entries.createBatch({
        fundId,
        submissionId: uuid(),
        entries: [
          makeEntry({ description: "first row would commit alone" }),
          makeEntry({ description: "trigger-mid-batch" }),
          makeEntry({ description: "last row" }),
        ],
        receipt: file(),
      }),
      (error: unknown) => {
        assert.equal(codeOf(error), "SERVICE_UNAVAILABLE");
        assert.doesNotMatch(messageOf(error), /private_trigger_marker/);
        return true;
      },
    );

    assert.equal((await fixture.db.select().from(entries)).length, 0);
    assert.equal((await fixture.db.select().from(entryBatches)).length, 0);
    const [uncommittedReceipt] = await fixture.db.select().from(receipts);
    assert.ok(uncommittedReceipt);
    assert.equal(uncommittedReceipt.state, "uploading");
    assert.ok(await fixture.receipts.get(uncommittedReceipt.objectKey));

    await cleanupReceipts(fixture.db, fixture.receipts, uncommittedReceipt.createdAt + DAY);
    assert.equal((await fixture.db.select().from(receipts)).length, 0);
    assert.equal(await fixture.receipts.get(uncommittedReceipt.objectKey), null);
  } finally {
    await fixture.close();
  }
});

test("receipt put failures are sanitized and post-commit batch response loss recovers evidence", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client);
    const failingBucket = new Proxy(fixture.receipts, {
      get(target, property) {
        if (property === "put") {
          return async () => {
            throw new Error("private_r2_put_marker");
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    }) as R2Bucket;
    fixture.context.receipts = failingBucket;

    await assert.rejects(
      fixture.client.entries.createBatch({
        fundId,
        submissionId: uuid(),
        entries: [makeEntry()],
        receipt: file(),
      }),
      (error: unknown) => {
        assert.equal(codeOf(error), "SERVICE_UNAVAILABLE");
        assert.doesNotMatch(messageOf(error), /private_r2_put_marker/);
        return true;
      },
    );
    assert.equal((await fixture.db.select().from(entries)).length, 0);
    assert.equal((await fixture.db.select().from(entryBatches)).length, 0);
    const [failedUpload] = await fixture.db.select().from(receipts);
    assert.ok(failedUpload);
    assert.equal(failedUpload.state, "uploading");
    assert.equal(await fixture.receipts.get(failedUpload.objectKey), null);
    fixture.context.receipts = fixture.receipts;

    let committedBatch: unknown;
    fixture.context.db = new Proxy(fixture.db, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (property === "batch" && typeof member === "function") {
          return async (...args: unknown[]) => {
            committedBatch = await Reflect.apply(member, target, args);
            throw new Error("private_response_loss_marker");
          };
        }
        return typeof member === "function" ? member.bind(target) : member;
      },
    }) as typeof fixture.db;

    const recovered = await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [makeEntry({ description: "committed before response loss" })],
      receipt: file(),
    });
    assert.ok(committedBatch);
    const [savedBatch] = await fixture.db.select().from(entryBatches);
    assert.ok(savedBatch);
    assert.deepEqual(recovered.entryIds, JSON.parse(savedBatch.entryIds));
    assert.equal(recovered.receiptId, savedBatch.receiptId);
    assert.equal((await fixture.db.select().from(entries)).length, 1);
    assert.equal((await fixture.db.select().from(entryBatches)).length, 1);
    assert.equal((await fixture.db.select().from(receipts)).length, 2);
    const savedReceipt = await fixture.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, recovered.receiptId!))
      .get();
    assert.ok(savedReceipt);
    assert.equal(savedReceipt.state, "ready");
    const restoredEvidence = await getReceipt(
      fixture.db,
      fixture.receipts,
      fundId,
      recovered.receiptId!,
    );
    assert.deepEqual(
      [...new Uint8Array(await new Response(restoredEvidence.body).arrayBuffer())],
      [0xff, 0xd8, 0xff, 0xd9],
    );
  } finally {
    await fixture.close();
  }
});

test("cleanup removes the exact oldest 100 receipts and leaves the 101st for the next pass", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client);
    const baseCreatedAt = 1_700_000_000_000;
    const receiptsToClean: { id: string; objectKey: string; createdAt: number }[] = [];
    for (let index = 100; index >= 0; index--) {
      const createdAt = baseCreatedAt + index;
      const receipt = await insertReceipt(fixture.db, fundId, "uploading", createdAt);
      receiptsToClean.push({ ...receipt, createdAt });
      await fixture.receipts.put(receipt.objectKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    }
    const expectedOldest = [...receiptsToClean]
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, 100);
    const newest = receiptsToClean.find(({ createdAt }) => createdAt === baseCreatedAt + 100)!;
    const cleanupTime = baseCreatedAt + DAY + 101;

    await cleanupReceipts(fixture.db, fixture.receipts, cleanupTime);
    const remainingRows = await fixture.db.select().from(receipts);
    assert.deepEqual(
      remainingRows.map(({ id }) => id),
      [newest.id],
    );
    assert.deepEqual(
      (await fixture.receipts.list()).objects.map(({ key }) => key),
      [newest.objectKey],
    );
    for (const receipt of expectedOldest) {
      assert.equal(await fixture.receipts.get(receipt.objectKey), null);
    }
    assert.ok(await fixture.receipts.get(newest.objectKey));

    await cleanupReceipts(fixture.db, fixture.receipts, cleanupTime);
    assert.equal((await fixture.db.select().from(receipts)).length, 0);
    assert.equal((await fixture.receipts.list()).objects.length, 0);
  } finally {
    await fixture.close();
  }
});

test("receipt reads hide uploading, deleting, unreferenced and missing-object states uniformly", async () => {
  const fixture = await createTestFixture();
  try {
    const { fundId } = await createFund(fixture.client);
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const unreferencedReady = await insertReceipt(fixture.db, fundId, "ready");
    await fixture.receipts.put(unreferencedReady.objectKey, imageBytes);

    const assertHidden = async (receiptId: string) => {
      await assert.rejects(
        getReceipt(fixture.db, fixture.receipts, fundId, receiptId),
        (error: unknown) => {
          assert.equal(codeOf(error), "NOT_FOUND");
          assert.equal(messageOf(error), "証憑が見つかりません");
          return true;
        },
      );
    };

    const committed = await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [makeEntry()],
      receipt: file(imageBytes),
    });
    const committedReceiptId = committed.receiptId;
    assert.ok(committedReceiptId);
    await fixture.db
      .update(receipts)
      .set({ state: "uploading" })
      .where(eq(receipts.id, committedReceiptId))
      .run();
    await assertHidden(committedReceiptId);
    await fixture.db
      .update(receipts)
      .set({ state: "deleting" })
      .where(eq(receipts.id, committedReceiptId))
      .run();
    await assertHidden(committedReceiptId);
    await fixture.db
      .update(receipts)
      .set({ state: "ready" })
      .where(eq(receipts.id, committedReceiptId))
      .run();
    const restoredObject = await getReceipt(
      fixture.db,
      fixture.receipts,
      fundId,
      committedReceiptId,
    );
    assert.deepEqual(new Uint8Array(await restoredObject.arrayBuffer()), imageBytes);
    await assertHidden(unreferencedReady.id);

    const missingObject = await fixture.client.entries.createBatch({
      fundId,
      submissionId: uuid(),
      entries: [makeEntry()],
      receipt: file(imageBytes),
    });
    assert.ok(missingObject.receiptId);
    const storedMissingReceipt = await fixture.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, missingObject.receiptId))
      .get();
    assert.ok(storedMissingReceipt);
    await fixture.receipts.delete(storedMissingReceipt.objectKey);
    await assertHidden(missingObject.receiptId);
  } finally {
    await fixture.close();
  }
});
