import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, lt, notExists, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { Database } from "@zandaka/db";
import { entryBatches, entries, funds, receipts } from "@zandaka/db/schema/index";

import { deleteReceipt, validateImage } from "./receipt-storage";
import {
  entryInputSchema,
  entrySchema,
  uuidV4Schema,
  type Entry,
  type EntryInput,
} from "./validation";

const imageMaxAgeMs = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export async function requireFund(db: Database, fundId: string) {
  const fund = await db.select().from(funds).where(eq(funds.id, fundId)).get();
  if (!fund) throw new ORPCError("NOT_FOUND", { message: "資金が見つかりません" });
  return fund;
}

export function verifyMasterKey(configuredKey: string | undefined, suppliedKey: string): void {
  const configuredBytes = encoder.encode(configuredKey ?? "");
  if (!configuredKey || configuredBytes.byteLength < 32) {
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "管理者キーが設定されていません",
    });
  }

  const suppliedBytes = encoder.encode(suppliedKey);
  if (
    configuredBytes.byteLength !== suppliedBytes.byteLength ||
    !timingSafeEqual(configuredBytes, suppliedBytes)
  ) {
    throw new ORPCError("UNAUTHORIZED", { message: "管理者キーが正しくありません" });
  }
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: BufferSource): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", value));
}

function requestJson(
  entriesInput: EntryInput[],
  image: { sha256: string; mimeType: string; sizeBytes: number } | null,
): string {
  return JSON.stringify({
    entries: entriesInput.map(({ occurredOn, kind, amountYen, description }) => ({
      occurredOn,
      kind,
      amountYen,
      description,
    })),
    image,
  });
}

type BatchResponse = { entryIds: string[]; receiptId: string | null };

async function readBatchResponse(
  db: Database,
  fundId: string,
  submissionId: string,
  requestHash: string,
): Promise<BatchResponse | null> {
  const batch = await db
    .select()
    .from(entryBatches)
    .where(and(eq(entryBatches.fundId, fundId), eq(entryBatches.submissionId, submissionId)))
    .get();
  if (!batch) return null;
  if (batch.requestHash !== requestHash) {
    throw new ORPCError("CONFLICT", {
      message: "同じ送信IDに異なる内容は記帳できません",
      data: {},
    });
  }
  return {
    entryIds: entryIdsSchema.parse(JSON.parse(batch.entryIds)),
    receiptId: batch.receiptId,
  };
}

const entryIdsSchema = z.array(uuidV4Schema).max(50);

async function recoverBatchResponse(
  db: Database,
  fundId: string,
  submissionId: string,
  requestHash: string,
): Promise<BatchResponse | null> {
  try {
    return await readBatchResponse(db, fundId, submissionId, requestHash);
  } catch (error) {
    if (error instanceof ORPCError && error.code === "CONFLICT") throw error;
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: "記帳結果を確認できませんでした" });
  }
}

function isReceiptGuardFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /not null constraint failed:\s*["`]?entry_batches["`]?\.["`]?fund_id/i.test(error.message);
}

function isSqliteIntegerOverflow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /integer overflow/i.test(error.message) ||
    (error.cause instanceof Error && /integer overflow/i.test(error.cause.message))
  );
}

function serviceUnavailable(message: string) {
  return new ORPCError("SERVICE_UNAVAILABLE", { message });
}

export async function createFund(
  db: Database,
  masterKey: string | undefined,
  input: { masterKey: string; name: string; openingBalanceYen: number },
): Promise<{ fundId: string }> {
  verifyMasterKey(masterKey, input.masterKey);
  const fundId = crypto.randomUUID();
  try {
    await db
      .insert(funds)
      .values({
        id: fundId,
        name: input.name,
        openingBalanceYen: input.openingBalanceYen,
        createdAt: Date.now(),
      })
      .run();
  } catch {
    throw serviceUnavailable("資金を作成できませんでした");
  }
  return { fundId };
}

export async function getFund(db: Database, fundId: string) {
  const fund = await requireFund(db, fundId);
  let totals: { incomeYen: string; expenseYen: string } | undefined;
  try {
    totals = await db.get<{ incomeYen: string; expenseYen: string }>(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN kind = 'income' THEN amount_yen ELSE 0 END), 0) AS TEXT) AS incomeYen,
        CAST(COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_yen ELSE 0 END), 0) AS TEXT) AS expenseYen
      FROM entries
      WHERE fund_id = ${fundId}
    `);
  } catch (error) {
    if (isSqliteIntegerOverflow(error)) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "記録金額の合計がSQLiteの整数範囲を超えています",
      });
    }
    throw error;
  }

  const income = BigInt(totals?.incomeYen ?? "0");
  const expense = BigInt(totals?.expenseYen ?? "0");
  return {
    id: fund.id,
    name: fund.name,
    openingBalanceYen: fund.openingBalanceYen,
    createdAt: fund.createdAt,
    incomeYen: income.toString(),
    expenseYen: expense.toString(),
    balanceYen: (BigInt(fund.openingBalanceYen) + income - expense).toString(),
  };
}

export async function listEntries(
  db: Database,
  fundId: string,
  cursor?: { occurredOn: string; createdAt: number; id: string },
) {
  await requireFund(db, fundId);
  const cursorCondition = cursor
    ? or(
        lt(entries.occurredOn, cursor.occurredOn),
        and(eq(entries.occurredOn, cursor.occurredOn), lt(entries.createdAt, cursor.createdAt)),
        and(
          eq(entries.occurredOn, cursor.occurredOn),
          eq(entries.createdAt, cursor.createdAt),
          lt(entries.id, cursor.id),
        ),
      )
    : undefined;

  const rows = await db
    .select()
    .from(entries)
    .where(
      cursorCondition
        ? and(eq(entries.fundId, fundId), cursorCondition)
        : eq(entries.fundId, fundId),
    )
    .orderBy(desc(entries.occurredOn), desc(entries.createdAt), desc(entries.id))
    .limit(51);
  const hasMore = rows.length > 50;
  const items = rows.slice(0, 50).map((row) => entrySchema.parse(row));
  const last = hasMore ? items[items.length - 1] : undefined;
  return {
    items,
    nextCursor: last
      ? { occurredOn: last.occurredOn, createdAt: last.createdAt, id: last.id }
      : null,
  };
}

export async function createBatch(
  db: Database,
  bucket: R2Bucket,
  input: {
    fundId: string;
    submissionId: string;
    entries: EntryInput[];
    receipt?: File;
  },
): Promise<BatchResponse> {
  await requireFund(db, input.fundId);
  const validatedEntries = input.entries.map((entry) => entryInputSchema.parse(entry));
  let image:
    | { bytes: ArrayBuffer; mimeType: string; sizeBytes: number; digest: string }
    | undefined;
  if (input.receipt) {
    const validatedImage = await validateImage(input.receipt);
    image = {
      ...validatedImage,
      digest: await sha256(validatedImage.bytes),
    };
  }
  const requestHash = await sha256(
    encoder.encode(
      requestJson(
        validatedEntries,
        image
          ? { sha256: image.digest, mimeType: image.mimeType, sizeBytes: image.sizeBytes }
          : null,
      ),
    ),
  );

  const existing = await readBatchResponse(db, input.fundId, input.submissionId, requestHash);
  if (existing) return existing;

  const receiptId = image ? crypto.randomUUID() : null;
  const now = Date.now();
  if (image && receiptId) {
    const objectKey = `${input.fundId}/${receiptId}`;
    try {
      await db
        .insert(receipts)
        .values({
          id: receiptId,
          fundId: input.fundId,
          objectKey,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          state: "uploading",
          createdAt: now,
        })
        .run();
      await bucket.put(objectKey, image.bytes, {
        httpMetadata: { contentType: image.mimeType },
      });
    } catch {
      const recovered = await recoverBatchResponse(
        db,
        input.fundId,
        input.submissionId,
        requestHash,
      );
      if (recovered) return recovered;
      throw serviceUnavailable("証憑を保存できませんでした");
    }
  }

  const entryIds = validatedEntries.map(() => crypto.randomUUID());
  const createdAt = Date.now();
  const statements = [
    ...(receiptId
      ? [
          db
            .update(receipts)
            .set({ state: "ready" })
            .where(
              and(
                eq(receipts.fundId, input.fundId),
                eq(receipts.id, receiptId),
                eq(receipts.state, "uploading"),
                sql`${receipts.createdAt} > ${Date.now() - imageMaxAgeMs}`,
              ),
            )
            .returning({ id: receipts.id }),
        ]
      : []),
    db.insert(entryBatches).values({
      fundId: receiptId
        ? sql`(SELECT ${receipts.fundId} FROM ${receipts} WHERE ${receipts.fundId} = ${input.fundId} AND ${receipts.id} = ${receiptId} AND ${receipts.state} = 'ready')`
        : input.fundId,
      submissionId: input.submissionId,
      requestHash,
      entryIds: JSON.stringify(entryIds),
      receiptId,
      createdAt,
    }),
    ...validatedEntries.map((entry, index) =>
      db.insert(entries).values({
        id: entryIds[index]!,
        fundId: input.fundId,
        submissionId: input.submissionId,
        occurredOn: entry.occurredOn,
        kind: entry.kind,
        amountYen: entry.amountYen,
        description: entry.description,
        receiptId,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      }),
    ),
  ];

  try {
    await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);
  } catch (error) {
    const recovered = await recoverBatchResponse(db, input.fundId, input.submissionId, requestHash);
    if (recovered) return recovered;
    if (receiptId && isReceiptGuardFailure(error)) {
      throw new ORPCError("CONFLICT", {
        message: "証憑のアップロード期限が切れました。もう一度送信してください",
        data: {},
      });
    }
    throw serviceUnavailable("記帳を保存できませんでした");
  }

  return { entryIds, receiptId };
}

async function readScopedEntry(
  db: Database,
  fundId: string,
  entryId: string,
): Promise<Entry | undefined> {
  const row = await db
    .select()
    .from(entries)
    .where(and(eq(entries.fundId, fundId), eq(entries.id, entryId)))
    .get();
  return row ? entrySchema.parse(row) : undefined;
}

export async function updateEntry(
  db: Database,
  fundId: string,
  entryId: string,
  version: number,
  input: EntryInput,
): Promise<Entry> {
  await requireFund(db, fundId);
  const entry = entryInputSchema.parse(input);
  const updatedAt = Date.now();
  const [updated] = await db
    .update(entries)
    .set({
      occurredOn: entry.occurredOn,
      kind: entry.kind,
      amountYen: entry.amountYen,
      description: entry.description,
      version: sql`${entries.version} + 1`,
      updatedAt,
    })
    .where(and(eq(entries.fundId, fundId), eq(entries.id, entryId), eq(entries.version, version)))
    .returning();
  if (updated) return entrySchema.parse(updated);

  const latest = await readScopedEntry(db, fundId, entryId);
  if (!latest) throw new ORPCError("NOT_FOUND", { message: "記録が見つかりません" });
  throw new ORPCError("CONFLICT", {
    message: "別の利用者が記録を更新しました",
    data: { latest },
  });
}

export async function deleteEntry(
  db: Database,
  bucket: R2Bucket,
  fundId: string,
  entryId: string,
  version: number,
): Promise<{ deletedId: string }> {
  await requireFund(db, fundId);
  const before = await readScopedEntry(db, fundId, entryId);
  if (!before) throw new ORPCError("NOT_FOUND", { message: "記録が見つかりません" });

  const statements = [
    db
      .delete(entries)
      .where(and(eq(entries.fundId, fundId), eq(entries.id, entryId), eq(entries.version, version)))
      .returning({ id: entries.id }),
    ...(before.receiptId
      ? [
          db
            .update(receipts)
            .set({ state: "deleting" })
            .where(
              and(
                eq(receipts.fundId, fundId),
                eq(receipts.id, before.receiptId),
                eq(receipts.state, "ready"),
                notExists(
                  db
                    .select({ id: entries.id })
                    .from(entries)
                    .where(
                      and(eq(entries.fundId, fundId), eq(entries.receiptId, before.receiptId)),
                    ),
                ),
              ),
            )
            .returning({ id: receipts.id }),
        ]
      : []),
  ];

  let deletedRows: Array<{ id: string }>;
  try {
    const results = await db.batch(
      statements as [(typeof statements)[number], ...(typeof statements)[number][]],
    );
    deletedRows = results[0] as Array<{ id: string }>;
  } catch {
    const latest = await readScopedEntry(db, fundId, entryId);
    if (!latest) throw new ORPCError("NOT_FOUND", { message: "記録が見つかりません" });
    if (latest.version !== version) {
      throw new ORPCError("CONFLICT", {
        message: "別の利用者が記録を更新しました",
        data: { latest },
      });
    }
    throw serviceUnavailable("記録を削除できませんでした");
  }

  if (deletedRows.length === 0) {
    const latest = await readScopedEntry(db, fundId, entryId);
    if (!latest) throw new ORPCError("NOT_FOUND", { message: "記録が見つかりません" });
    throw new ORPCError("CONFLICT", {
      message: "別の利用者が記録を更新しました",
      data: { latest },
    });
  }

  if (before.receiptId) {
    try {
      await deleteReceipt(db, bucket, fundId, before.receiptId);
    } catch {
      // The deleting row is retained for the scheduled cleanup retry.
    }
  }
  return { deletedId: entryId };
}
