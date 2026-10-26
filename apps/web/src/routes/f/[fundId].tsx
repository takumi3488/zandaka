import { Title } from "@solidjs/meta";
import { useParams } from "@solidjs/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { Errored, For, Loading, Show, createEffect, createMemo, createSignal } from "solid-js";

import EntryForm from "~/components/entry-form";
import { client, orpc } from "~/utils/orpc";
import {
  entryInputSchema,
  entrySchema,
  uuidV4Schema,
  type Cursor,
  type Entry,
  type EntryInput,
} from "@zandaka/api/validation";

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function latestFromError(error: unknown): Entry | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = error.data;
  if (!data || typeof data !== "object" || !("latest" in data)) return null;
  const parsed = entrySchema.safeParse(data.latest);
  return parsed.success ? parsed.data : null;
}

function inputFromEntry(entry: Entry): EntryInput {
  return {
    occurredOn: entry.occurredOn,
    kind: entry.kind,
    amountYen: entry.amountYen,
    description: entry.description,
  };
}

function formatYen(value: string | number) {
  return new Intl.NumberFormat("ja-JP").format(typeof value === "string" ? BigInt(value) : value);
}

function describeEntry(entry: Entry) {
  const type = entry.kind === "income" ? "入金" : "出金";
  return `${entry.occurredOn} ${type} ${formatYen(entry.amountYen)}円${entry.description ? ` ${entry.description}` : ""}`;
}

function readableError(error: unknown) {
  switch (errorCode(error)) {
    case "NOT_FOUND":
      return "この資金または記録は見つかりません。共有URLを確認してください。";
    case "CONFLICT":
      return "ほかの人が記録を更新しました。最新の内容を確認してください。";
    default:
      return "台帳を読み込めませんでした。通信状態を確認して再度お試しください。";
  }
}

type EditState = { entryId: string; version: number; entry: EntryInput };
type DeleteState = { entry: Entry; version: number; latest?: Entry; latestConfirmed: boolean };
type EntriesPage = { items: Entry[]; nextCursor: Cursor | null };

export default function FundLedger() {
  const params = useParams<{ fundId: string }>();
  const queryClient = useQueryClient();
  const [cursorStack, setCursorStack] = createSignal<Array<Cursor | null>>([null]);
  const [pageIndex, setPageIndex] = createSignal(0);
  const [paging, setPaging] = createSignal(false);
  const [pagingError, setPagingError] = createSignal("");
  const [shareCopyError, setShareCopyError] = createSignal(false);
  const [editing, setEditing] = createSignal<EditState>();
  const [editError, setEditError] = createSignal("");
  const [editConflict, setEditConflict] = createSignal<Entry>();
  const [deleteState, setDeleteState] = createSignal<DeleteState>();
  const [deleteError, setDeleteError] = createSignal("");
  function commitPage(targetIndex: number, cursor: Cursor | null, replaceForward: boolean) {
    if (replaceForward) {
      setCursorStack((existing) => [...existing.slice(0, targetIndex), cursor]);
    }
    setPageIndex(targetIndex);
  }
  const fundId = () => params.fundId;
  const validFundId = () => uuidV4Schema.safeParse(fundId()).success;
  const summaryOptions = () => orpc.funds.get.queryOptions({ input: { fundId: fundId() } });
  const listOptionsForCursor = (cursor: Cursor | null) =>
    orpc.entries.list.queryOptions({
      input: { fundId: fundId(), cursor: cursor ?? undefined },
    });
  const listOptions = () => listOptionsForCursor(cursorStack()[pageIndex()] ?? null);

  const fundQuery = useQuery(() => ({
    ...summaryOptions(),
    enabled: validFundId(),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "visible" ? 15_000 : false,
    refetchIntervalInBackground: false,
  }));
  const entriesQuery = useQuery(() => ({
    ...listOptions(),
    enabled: validFundId(),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: "always",
    refetchInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "visible" ? 15_000 : false,
    refetchIntervalInBackground: false,
  }));
  // Solid Query 6 RC leaves empty page refetches stale; remove when the adapter propagates them.
  const [pageSnapshot, setPageSnapshot] = createSignal<{
    queryHash: string;
    data: EntriesPage;
  }>();
  const activeListQuery = createMemo(() => {
    const options = listOptions();
    return {
      queryHash: queryClient.defaultQueryOptions(options).queryHash,
      queryKey: options.queryKey,
    };
  });
  const entriesPage = () => {
    const snapshot = pageSnapshot();
    return snapshot?.queryHash === activeListQuery().queryHash ? snapshot.data : entriesQuery.data;
  };
  createEffect(
    () => activeListQuery(),
    ({ queryHash, queryKey }) => {
      const update = (data: EntriesPage | undefined) => {
        if (data !== undefined) setPageSnapshot({ queryHash, data });
      };
      update(queryClient.getQueryData<EntriesPage>(queryKey));
      return queryClient.getQueryCache().subscribe((event) => {
        if (
          event.query.queryHash === queryHash &&
          event.type === "updated" &&
          event.action.type === "success"
        ) {
          update(event.query.state.data as EntriesPage | undefined);
        }
      });
    },
  );

  async function refreshLedger() {
    setCursorStack([null]);
    setPageIndex(0);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: summaryOptions().queryKey }),
      queryClient.invalidateQueries({
        queryKey: orpc.entries.list.queryOptions({ input: { fundId: fundId() } }).queryKey,
      }),
    ]);
  }

  const updateMutation = useMutation(() => ({
    mutationFn: (value: EditState) =>
      client.entries.update({
        fundId: fundId(),
        entryId: value.entryId,
        version: value.version,
        entry: value.entry,
      }),
    retry: false,
    onSuccess: () => {
      setEditing(undefined);
      setEditConflict(undefined);
      setEditError("");
      void refreshLedger();
    },
    onError: (error) => {
      const latest = latestFromError(error);
      if (latest) setEditConflict(latest);
      else setEditError(readableError(error));
    },
  }));

  const deleteMutation = useMutation(() => ({
    mutationFn: (value: { entryId: string; version: number }) =>
      client.entries.delete({ fundId: fundId(), ...value }),
    retry: false,
    onSuccess: () => {
      setDeleteState(undefined);
      setDeleteError("");
      void refreshLedger();
    },
    onError: (error) => {
      const latest = latestFromError(error);
      if (latest) {
        setDeleteState((current) =>
          current ? { ...current, latest, latestConfirmed: false } : current,
        );
        setDeleteError(
          "ほかの人が記録を更新しました。最新の内容を確認してから、削除をもう一度選んでください。",
        );
      } else {
        setDeleteError(readableError(error));
      }
    },
  }));

  function startEdit(entry: Entry) {
    setDeleteState(undefined);
    setEditing({ entryId: entry.id, version: entry.version, entry: inputFromEntry(entry) });
    setEditConflict(undefined);
    setEditError("");
  }

  function updateEditField<K extends keyof EntryInput>(field: K, value: EntryInput[K]) {
    setEditing((current) =>
      current ? { ...current, entry: { ...current.entry, [field]: value } } : current,
    );
  }

  function saveEdit(event: SubmitEvent) {
    event.preventDefault();
    const value = editing();
    if (!value) return;
    const parsed = entryInputSchema.safeParse(value.entry);
    if (!parsed.success) {
      setEditError("日付、区分、1円以上の整数金額、説明を確認してください。");
      return;
    }
    setEditError("");
    updateMutation.mutate({ ...value, entry: parsed.data });
  }

  function confirmDelete() {
    const current = deleteState();
    if (!current || (current.latest && !current.latestConfirmed)) return;
    setDeleteError("");
    deleteMutation.mutate({ entryId: current.entry.id, version: current.version });
  }

  function openDelete(entry: Entry) {
    setEditing(undefined);
    setDeleteError("");
    setDeleteState({ entry, version: entry.version, latestConfirmed: false });
  }

  async function navigatePage(targetIndex: number, cursor: Cursor | null, replaceForward: boolean) {
    if (paging()) return;
    setPaging(true);
    setPagingError("");
    try {
      // Load the destination before changing the reactive key; a cold query can hold the page-state write.
      await queryClient.fetchQuery({
        ...listOptionsForCursor(cursor),
        retry: false,
        staleTime: 15_000,
      });
      commitPage(targetIndex, cursor, replaceForward);
    } catch {
      setPagingError("記録を読み込めませんでした。時間をおいて再度お試しください。");
    } finally {
      setPaging(false);
    }
  }

  function moveForward() {
    const next = entriesPage()?.nextCursor;
    if (next) void navigatePage(pageIndex() + 1, next, true);
  }

  function moveBackward() {
    const targetIndex = pageIndex() - 1;
    if (targetIndex >= 0) void navigatePage(targetIndex, cursorStack()[targetIndex] ?? null, false);
  }

  async function copyShareUrl() {
    try {
      await navigator.clipboard.writeText(window.location.href.split("?")[0]!);
      setShareCopyError(false);
    } catch {
      setShareCopyError(true);
    }
  }

  const amountText = (entry: Entry) =>
    `${entry.kind === "income" ? "+" : "−"}${formatYen(entry.amountYen)}円`;

  return (
    <main class="page-shell ledger-page">
      <Show
        when={validFundId()}
        fallback={
          <section class="paper-section not-found" role="status">
            <Title>資金が見つかりません | zandaka</Title>
            <h1>資金が見つかりません</h1>
            <p>共有URLを確認してください。</p>
            <a href="/">ホームへ戻る</a>
          </section>
        }
      >
        <Errored
          fallback={(error, reset) => {
            const missing = errorCode(error()) === "NOT_FOUND";
            return (
              <section class="paper-section not-found" role={missing ? "status" : undefined}>
                <Title>
                  {missing ? "資金が見つかりません | zandaka" : "台帳を開けません | zandaka"}
                </Title>
                <h1>{missing ? "資金が見つかりません" : "台帳を開けません"}</h1>
                <p role={missing ? undefined : "alert"}>
                  {missing
                    ? "共有URLが正しいか確認してください。"
                    : "台帳を読み込めませんでした。通信状態を確認して再度お試しください。"}
                </p>
                <Show when={!missing}>
                  <button
                    class="button button-secondary"
                    type="button"
                    onClick={() => {
                      void Promise.all([fundQuery.refetch(), entriesQuery.refetch()]).then(reset);
                    }}
                  >
                    もう一度読み込む
                  </button>
                </Show>
                <a href="/">ホームへ戻る</a>
              </section>
            );
          }}
        >
          <Show
            when={fundQuery.data}
            fallback={
              <section class="paper-section loading-state" aria-live="polite">
                <Title>共有台帳 | zandaka</Title>
                <Show when={fundQuery.isPending}>
                  <p>台帳を読み込んでいます…</p>
                </Show>
                <Show when={!fundQuery.isPending && errorCode(fundQuery.error) === "NOT_FOUND"}>
                  <h1>資金が見つかりません</h1>
                  <p>共有URLが正しいか確認してください。</p>
                  <a href="/">ホームへ戻る</a>
                </Show>
                <Show when={!fundQuery.isPending && errorCode(fundQuery.error) !== "NOT_FOUND"}>
                  <h1>台帳を開けません</h1>
                  <p role="alert">{readableError(fundQuery.error)}</p>
                  <button
                    class="button button-secondary"
                    type="button"
                    onClick={() => void fundQuery.refetch()}
                  >
                    もう一度読み込む
                  </button>
                </Show>
              </section>
            }
          >
            {(fund) => (
              <>
                <Title>{fund().name} | zandaka</Title>
                <header class="ledger-heading">
                  <div>
                    <p class="section-kicker">共有台帳</p>
                    <h1>{fund().name}</h1>
                    <p>このURLを知っている人は、記録を閲覧・編集できます。</p>
                  </div>
                  <div class="share-tools">
                    <button
                      class="button button-secondary"
                      type="button"
                      onClick={() => void copyShareUrl()}
                    >
                      共有URLをコピー
                    </button>
                    <Show when={shareCopyError()}>
                      <label>
                        共有URL
                        <input
                          type="url"
                          readonly
                          value={
                            typeof window === "undefined" ? "" : window.location.href.split("?")[0]
                          }
                          onFocus={(event) => event.currentTarget.select()}
                        />
                      </label>
                    </Show>
                    <Show when={shareCopyError()}>
                      <span class="field-help" role="status">
                        URLを選択してコピーしてください。
                      </span>
                    </Show>
                  </div>
                </header>
                <Show when={fundQuery.error}>
                  <p class="form-error" role="alert">
                    集計を更新できませんでした。表示している金額は前回の読み込み結果です。
                  </p>
                  <button
                    class="button button-secondary"
                    type="button"
                    onClick={() => void fundQuery.refetch()}
                  >
                    集計を再読み込み
                  </button>
                </Show>

                <section class="ledger-summary" aria-label="残高の概要">
                  <div>
                    <span>開始残高</span>
                    <strong>{formatYen(fund().openingBalanceYen)}円</strong>
                  </div>
                  <div>
                    <span>入金合計</span>
                    <strong class="income-text">{formatYen(fund().incomeYen)}円</strong>
                  </div>
                  <div>
                    <span>出金合計</span>
                    <strong class="expense-text">{formatYen(fund().expenseYen)}円</strong>
                  </div>
                  <div class="current-balance">
                    <span>現在残高</span>
                    <strong>{formatYen(fund().balanceYen)}円</strong>
                  </div>
                </section>

                <div class="ledger-layout">
                  <section class="records-section" aria-labelledby="records-title">
                    <Loading
                      fallback={
                        <p class="empty-state" role="status">
                          記録を読み込んでいます…
                        </p>
                      }
                    >
                      <div class="section-heading-row">
                        <h2 id="records-title">記録</h2>
                        <Show when={entriesPage()}>
                          <span>{entriesPage()?.items.length ?? 0}件を表示</span>
                        </Show>
                      </div>
                      <Show when={entriesQuery.isPending && !entriesPage()}>
                        <p class="empty-state">記録を読み込んでいます…</p>
                      </Show>
                      <Show when={entriesQuery.error && !entriesPage()}>
                        <p class="form-error" role="alert">
                          {readableError(entriesQuery.error)}
                        </p>
                        <button
                          class="button button-secondary"
                          type="button"
                          onClick={() => void entriesQuery.refetch()}
                        >
                          もう一度読み込む
                        </button>
                      </Show>
                      <Show when={entriesQuery.error && entriesPage()}>
                        <p class="form-error" role="alert">
                          記録を更新できませんでした。表示している内容は前回の読み込み結果です。
                        </p>
                        <button
                          class="button button-secondary"
                          type="button"
                          onClick={() => void entriesQuery.refetch()}
                        >
                          記録を再読み込み
                        </button>
                      </Show>
                      <Show when={entriesPage()}>
                        <Show
                          when={(entriesPage()?.items.length ?? 0) > 0}
                          fallback={
                            <div class="empty-state">
                              <h3>まだ記録がありません</h3>
                              <p>最初の入金または出金を入力欄から記帳してください。</p>
                            </div>
                          }
                        >
                          <div class="record-list">
                            <For each={entriesPage()?.items}>
                              {(entry) => (
                                <article class="record-row">
                                  <div class="record-main">
                                    <time datetime={entry.occurredOn}>{entry.occurredOn}</time>
                                    <span
                                      class={`kind-label ${entry.kind === "income" ? "kind-income" : "kind-expense"}`}
                                    >
                                      {entry.kind === "income" ? "入金" : "出金"}
                                    </span>
                                    <p>{entry.description || "（内容の記載なし）"}</p>
                                    <strong
                                      class={`record-amount ${entry.kind === "income" ? "income-text" : "expense-text"}`}
                                    >
                                      {amountText(entry)}
                                    </strong>
                                  </div>
                                  <Show when={entry.receiptId}>
                                    <a
                                      class="record-receipt"
                                      href={`/api/funds/${fundId()}/receipts/${entry.receiptId}`}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      <img
                                        class="receipt-thumbnail"
                                        src={`/api/funds/${fundId()}/receipts/${entry.receiptId}`}
                                        alt="証憑画像"
                                        loading="lazy"
                                        decoding="async"
                                      />
                                    </a>
                                  </Show>
                                  <div class="record-actions">
                                    <button
                                      class="button button-quiet"
                                      type="button"
                                      disabled={
                                        updateMutation.isPending ||
                                        deleteMutation.isPending ||
                                        !!editing() ||
                                        !!deleteState()
                                      }
                                      onClick={() => startEdit(entry)}
                                    >
                                      編集
                                    </button>
                                    <button
                                      class="button button-quiet danger-action"
                                      type="button"
                                      disabled={
                                        updateMutation.isPending ||
                                        deleteMutation.isPending ||
                                        !!editing() ||
                                        !!deleteState()
                                      }
                                      onClick={() => openDelete(entry)}
                                    >
                                      削除
                                    </button>
                                  </div>
                                </article>
                              )}
                            </For>
                          </div>
                        </Show>
                        <Show when={pagingError()}>
                          <p class="form-error" role="alert">
                            {pagingError()}
                          </p>
                        </Show>
                        <Show when={paging()}>
                          <p class="field-help" role="status">
                            記録を読み込んでいます…
                          </p>
                        </Show>
                        <nav class="pagination" aria-label="記録のページ">
                          <button
                            class="button button-quiet"
                            type="button"
                            disabled={
                              pageIndex() === 0 ||
                              paging() ||
                              updateMutation.isPending ||
                              deleteMutation.isPending ||
                              !!editing() ||
                              !!deleteState()
                            }
                            onClick={moveBackward}
                          >
                            前の50件
                          </button>
                          <span>ページ {pageIndex() + 1}</span>
                          <button
                            class="button button-quiet"
                            type="button"
                            disabled={
                              !entriesPage()?.nextCursor ||
                              paging() ||
                              updateMutation.isPending ||
                              deleteMutation.isPending ||
                              !!editing() ||
                              !!deleteState()
                            }
                            onClick={moveForward}
                          >
                            次の50件
                          </button>
                        </nav>
                      </Show>
                    </Loading>
                    <Show when={editing()}>
                      {(state) => (
                        <form class="record-editor" onSubmit={saveEdit}>
                          <h3>記録を編集</h3>
                          <label>
                            日付
                            <input
                              type="date"
                              required
                              disabled={updateMutation.isPending || deleteMutation.isPending}
                              value={state().entry.occurredOn}
                              onInput={(event) =>
                                updateEditField("occurredOn", event.currentTarget.value)
                              }
                            />
                          </label>
                          <label>
                            区分
                            <select
                              disabled={updateMutation.isPending || deleteMutation.isPending}
                              value={state().entry.kind}
                              onChange={(event) =>
                                updateEditField(
                                  "kind",
                                  event.currentTarget.value as EntryInput["kind"],
                                )
                              }
                            >
                              <option value="income">入金</option>
                              <option value="expense">出金</option>
                            </select>
                          </label>
                          <label>
                            金額（円）
                            <input
                              type="number"
                              min="1"
                              max="999999999999"
                              step="1"
                              inputmode="numeric"
                              required
                              disabled={updateMutation.isPending || deleteMutation.isPending}
                              value={state().entry.amountYen}
                              onInput={(event) =>
                                updateEditField("amountYen", Number(event.currentTarget.value))
                              }
                            />
                          </label>
                          <label>
                            内容
                            <input
                              type="text"
                              maxlength="500"
                              disabled={updateMutation.isPending || deleteMutation.isPending}
                              value={state().entry.description}
                              onInput={(event) =>
                                updateEditField("description", event.currentTarget.value)
                              }
                            />
                          </label>
                          <Show when={editError()}>
                            <p class="form-error" role="alert">
                              {editError()}
                            </p>
                          </Show>
                          <Show when={editConflict()}>
                            {(latest) => (
                              <section class="conflict-panel" aria-label="記録の競合内容">
                                <h4>最新の記録</h4>
                                <p>{describeEntry(latest())}</p>
                                <p>
                                  入力中の内容は保持しています。最新内容で編集し直す場合だけ、下の操作を選んでください。
                                </p>
                                <button
                                  class="button button-secondary"
                                  type="button"
                                  disabled={updateMutation.isPending}
                                  onClick={() => {
                                    setEditing({
                                      entryId: latest().id,
                                      version: latest().version,
                                      entry: inputFromEntry(latest()),
                                    });
                                    setEditConflict(undefined);
                                  }}
                                >
                                  最新内容で編集し直す
                                </button>
                              </section>
                            )}
                          </Show>
                          <div class="button-row">
                            <button
                              class="button button-primary"
                              type="submit"
                              disabled={updateMutation.isPending || deleteMutation.isPending}
                            >
                              {updateMutation.isPending ? "保存中…" : "変更を保存する"}
                            </button>
                            <button
                              class="button button-quiet"
                              type="button"
                              disabled={updateMutation.isPending || deleteMutation.isPending}
                              onClick={() => {
                                setEditing(undefined);
                                setEditConflict(undefined);
                                setEditError("");
                              }}
                            >
                              編集をやめる
                            </button>
                          </div>
                        </form>
                      )}
                    </Show>
                    <Show when={deleteState()}>
                      {(state) => (
                        <section
                          class="delete-confirmation"
                          aria-labelledby="delete-title"
                          aria-describedby="delete-description"
                        >
                          <h3 id="delete-title">記録を削除しますか？</h3>
                          <p id="delete-description">{describeEntry(state().entry)}</p>
                          <Show when={deleteError()}>
                            <p class="form-error" role="alert">
                              {deleteError()}
                            </p>
                          </Show>
                          <Show when={state().latest && !state().latestConfirmed}>
                            <div class="conflict-panel">
                              <h4>最新の記録</h4>
                              <p>{describeEntry(state().latest!)}</p>
                              <button
                                class="button button-secondary"
                                type="button"
                                disabled={deleteMutation.isPending}
                                onClick={() => {
                                  const latest = state().latest;
                                  if (!latest) return;
                                  setDeleteState({
                                    entry: latest,
                                    version: latest.version,
                                    latest,
                                    latestConfirmed: true,
                                  });
                                  setDeleteError("");
                                }}
                              >
                                最新内容を確認して削除を続ける
                              </button>
                            </div>
                          </Show>
                          <Show when={!state().latest || state().latestConfirmed}>
                            <div class="button-row">
                              <button
                                class="button button-danger"
                                type="button"
                                disabled={deleteMutation.isPending || updateMutation.isPending}
                                onClick={confirmDelete}
                              >
                                {deleteMutation.isPending ? "削除中…" : "削除を確定する"}
                              </button>
                              <button
                                class="button button-quiet"
                                type="button"
                                disabled={deleteMutation.isPending || updateMutation.isPending}
                                onClick={() => {
                                  setDeleteState(undefined);
                                  setDeleteError("");
                                }}
                              >
                                キャンセル
                              </button>
                            </div>
                          </Show>
                        </section>
                      )}
                    </Show>
                  </section>

                  <aside class="entry-column">
                    <EntryForm fundId={fundId()} onSaved={() => void refreshLedger()} />
                  </aside>
                </div>
              </>
            )}
          </Show>
        </Errored>
      </Show>
    </main>
  );
}
