import { useMutation } from "@tanstack/solid-query";
import { For, Show, createEffect, createSignal, onSettled } from "solid-js";

import { client } from "~/utils/orpc";
import { entryInputSchema, type EntryInput } from "@zandaka/api/validation";

type Submission = {
  submissionId: string;
  entries: EntryInput[];
  receipt?: File;
};

type PendingSave = {
  fundId: string;
  submission: Submission;
  fromManual: boolean;
};

type Props = {
  fundId: string;
  onSaved: () => void;
};

const LOCKED_MESSAGE = "読み取り・記帳の処理中、または記帳結果の確認中は画像を変更できません。";
const UNSUPPORTED_MESSAGE =
  "JPEG・PNG・WebPの画像を5MiB以内で1枚選んでください。未対応形式は変換してからお使いください。";
const UNREADABLE_MESSAGE =
  "読み取り結果に日付・区分・1円以上の金額が確定できない項目があるため、何も保存していません。画像は残しています。下の手入力で内容を入力すると、画像を証憑として一緒に記帳できます。";
const EMPTY_MESSAGE =
  "読み取れる入出金がありませんでした。何も保存していません。画像は残しています。下の手入力で記帳できます。";

function messageFor(error: unknown, purpose: "scan" | "save") {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (purpose === "scan") {
    if (code === "TOO_MANY_REQUESTS")
      return "画像の読み取り回数が上限に達しました。時間をおいて再度お試しください。";
    if (code === "SERVICE_UNAVAILABLE")
      return "画像の読み取りは現在利用できません。画像を残して手入力へ切り替えてください。";
    if (code === "GATEWAY_TIMEOUT")
      return "画像の読み取りが時間切れになりました。画像を残して手入力へ切り替えるか、再度お試しください。";
    return "画像を読み取れませんでした。画像を残して手入力へ切り替えるか、別の画像をお試しください。";
  }
  if (code === "NOT_FOUND") return "この資金を確認できません。共有URLを確認してください。";
  if (code === "CONFLICT")
    return "送信内容の確認が必要です。同じ内容のまま、結果を再確認してください。";
  if (code === "BAD_REQUEST") return "入力内容を確認してください。";
  return "記帳結果を確認できませんでした。同じ内容で結果を再確認してください。";
}
function createSubmission(entries: EntryInput[], receipt?: File): Submission {
  return Object.freeze({
    submissionId: crypto.randomUUID(),
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
    ...(receipt ? { receipt } : {}),
  }) as Submission;
}

function todayInTokyo() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function emptyManualEntry(): EntryInput {
  return { occurredOn: todayInTokyo(), kind: "expense", amountYen: 1, description: "" };
}

function isSupportedImage(file: File) {
  return (
    ["image/jpeg", "image/png", "image/webp"].includes(file.type) &&
    file.size > 0 &&
    file.size <= 5 * 1024 * 1024
  );
}

export default function EntryForm(props: Props) {
  const [manual, setManual] = createSignal<EntryInput>(emptyManualEntry());
  const [amount, setAmount] = createSignal("");
  const [formError, setFormError] = createSignal("");
  const [selectedFile, setSelectedFile] = createSignal<File>();
  const [previewUrl, setPreviewUrl] = createSignal("");
  const [fileError, setFileError] = createSignal("");
  const [dragActive, setDragActive] = createSignal(false);
  const [scanError, setScanError] = createSignal("");
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [status, setStatus] = createSignal("");
  const [pending, setPending] = createSignal<PendingSave>();
  const [submitError, setSubmitError] = createSignal("");
  const [canEditPending, setCanEditPending] = createSignal(false);
  const [hydrated, setHydrated] = createSignal(false);
  onSettled(() => {
    setHydrated(true);
  });

  // SSR exposes the form before client event handlers are attached.
  let flight = false;
  const locked = () =>
    !hydrated() || scanMutation.isPending || saveMutation.isPending || pending() !== undefined;

  createEffect(
    () => selectedFile(),
    (file) => {
      if (!file) {
        setPreviewUrl("");
        return;
      }
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    },
  );

  const scanMutation = useMutation(() => ({
    mutationFn: (input: { fundId: string; image: File }) => client.receipts.scan(input),
    retry: false,
  }));
  const saveMutation = useMutation(() => ({
    mutationFn: (input: PendingSave) =>
      client.entries.createBatch({ fundId: input.fundId, ...input.submission }),
    retry: false,
  }));

  function setManualField<K extends keyof EntryInput>(field: K, value: EntryInput[K]) {
    setManual((previous) => ({ ...previous, [field]: value }));
  }

  // Caller holds `flight`; it is released once this save settles. The pending snapshot is
  // the exact object sent, so a retry resends the same submissionId and payload.
  function startSave(next: PendingSave) {
    setPending(next);
    setCanEditPending(false);
    setSubmitError("");
    setStatus("");
    void (async () => {
      try {
        await saveMutation.mutate(next);
        setPending(undefined);
        setCanEditPending(false);
        setSubmitError("");
        setScanError("");
        setFileError("");
        setSelectedFile(undefined);
        if (next.fromManual) {
          setManual(emptyManualEntry());
          setAmount("");
          setFormError("");
          setWarnings([]);
        }
        setStatus(
          `${next.submission.entries.length}件を記帳しました${next.submission.receipt ? "。画像は証憑として保存しました。" : "。"}`,
        );
        props.onSaved();
      } catch (error) {
        setSubmitError(messageFor(error, "save"));
        setCanEditPending(
          error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "BAD_REQUEST",
        );
      } finally {
        flight = false;
      }
    })();
  }

  function submitManual(event: SubmitEvent) {
    event.preventDefault();
    if (flight || locked()) return;
    const parsed = entryInputSchema.safeParse({ ...manual(), amountYen: Number(amount()) });
    if (!parsed.success) {
      setFormError("日付、区分、1円以上の整数金額、説明を確認してください。");
      return;
    }
    setFormError("");
    flight = true;
    startSave({
      fundId: props.fundId,
      submission: createSubmission([parsed.data], selectedFile()),
      fromManual: true,
    });
  }

  // Caller holds `flight`. The file and fund are passed in explicitly: setters flush later,
  // so the signal is never read back here. Saves only when every extracted item is complete.
  async function readImage(fundId: string, file: File) {
    setSelectedFile(file);
    setScanError("");
    setFileError("");
    setWarnings([]);
    try {
      const result = await scanMutation.mutate({ fundId, image: file });
      setWarnings(result.warnings);
      const checked = result.entries.map((draft) => entryInputSchema.safeParse(draft));
      const valid = checked.flatMap((item) => (item.success ? [item.data] : []));
      if (checked.length === 0) {
        setStatus("");
        setScanError(EMPTY_MESSAGE);
        flight = false;
        return;
      }
      if (valid.length !== checked.length) {
        setStatus("");
        setScanError(UNREADABLE_MESSAGE);
        flight = false;
        return;
      }
      startSave({ fundId, submission: createSubmission(valid, file), fromManual: false });
    } catch (error) {
      setStatus("");
      setScanError(messageFor(error, "scan"));
      flight = false;
    }
  }

  // Single entry point for picker and drop. Rejections never call the provider.
  function handleFiles(files: File[]) {
    if (flight || locked()) {
      setFileError(LOCKED_MESSAGE);
      return;
    }
    const file = files.length === 1 ? files[0] : undefined;
    if (!file) {
      setFileError(
        files.length === 0
          ? "画像ファイルを1枚ドロップしてください。"
          : "画像は1枚ずつ選んでください。複数枚は受け付けません。",
      );
      return;
    }
    if (!isSupportedImage(file)) {
      setFileError(UNSUPPORTED_MESSAGE);
      return;
    }
    flight = true;
    void readImage(props.fundId, file);
  }

  function rereadImage() {
    const file = selectedFile();
    if (!file || flight || locked()) return;
    flight = true;
    void readImage(props.fundId, file);
  }

  function removeImage() {
    if (flight || locked()) return;
    setSelectedFile(undefined);
    setScanError("");
    setFileError("");
    setWarnings([]);
    setStatus("");
  }

  function retrySave() {
    const current = pending();
    if (!current || flight) return;
    flight = true;
    startSave(current);
  }

  function editPendingInput() {
    if (flight) return;
    setPending(undefined);
    setCanEditPending(false);
    setSubmitError("");
  }

  function onDragOver(event: DragEvent) {
    // Always prevent default so a dropped file never navigates the page away.
    event.preventDefault();
    if (!locked()) setDragActive(true);
  }

  function onDragLeave(event: DragEvent & { currentTarget: HTMLLabelElement }) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDragActive(false);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragActive(false);
    handleFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  return (
    <section class="entry-panel" aria-labelledby="entry-panel-title">
      <h2 id="entry-panel-title">入出金を記帳する</h2>

      <section class="image-entry" aria-labelledby="image-entry-title">
        <h3 id="image-entry-title">画像から記帳</h3>
        <label
          class={`dropzone${dragActive() ? " is-active" : ""}${locked() ? " is-locked" : ""}`}
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <input
            class="dropzone-input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={locked()}
            onChange={(event) => {
              const input = event.currentTarget;
              const files = Array.from(input.files ?? []);
              input.value = "";
              if (files.length > 0) handleFiles(files);
            }}
          />
          <span class="dropzone-title">
            {dragActive() ? "ここに離して画像を選ぶ" : "画像をドロップ、または選択"}
          </span>
        </label>
        <Show when={fileError()}>
          <p class="form-error" role="alert">
            {fileError()}
          </p>
        </Show>
        <Show when={selectedFile()}>
          <figure class="image-preview">
            <img src={previewUrl()} alt="選択した画像のプレビュー" />
            <figcaption>{selectedFile()?.name} を選択中</figcaption>
          </figure>
          <div class="button-row">
            <Show when={scanError()}>
              <button
                class="button button-secondary"
                type="button"
                disabled={locked()}
                onClick={rereadImage}
              >
                画像を読み直す
              </button>
            </Show>
            <button
              class="button button-quiet"
              type="button"
              disabled={locked()}
              onClick={removeImage}
            >
              画像を外す
            </button>
          </div>
        </Show>
        <div class="form-status-region" role="status" aria-live="polite">
          <Show when={scanMutation.isPending || saveMutation.isPending || status()}>
            <p class="form-status">
              {scanMutation.isPending
                ? "画像を読み取り中…"
                : saveMutation.isPending
                  ? "記帳中…"
                  : status()}
            </p>
          </Show>
        </div>
        <Show when={scanError()}>
          <p class="form-error" role="alert">
            {scanError()}
          </p>
          <p class="panel-intro">
            画像は選択したままです。読み直すか、下の手入力で内容を入力して証憑付きで記帳できます。
          </p>
        </Show>
        <Show when={warnings().length > 0}>
          <ul class="warning-list" aria-label="読み取り時の注意">
            <For each={warnings()}>{(warning) => <li>{warning}</li>}</For>
          </ul>
        </Show>
      </section>

      <Show when={pending()}>
        <section
          class="pending-submission"
          aria-live="polite"
          aria-labelledby="pending-submission-title"
        >
          <h3 id="pending-submission-title">記帳結果を確認してください</h3>
          <p role={submitError() ? "alert" : undefined}>
            {submitError() ||
              (saveMutation.isPending ? "記帳しています。" : "記帳結果をまだ確認できていません。")}
          </p>
          <p>送信IDを保ったまま、同じ内容を再送して結果を確認できます。</p>
          <button
            class="button button-secondary"
            type="button"
            disabled={saveMutation.isPending}
            onClick={retrySave}
          >
            {saveMutation.isPending ? "確認中…" : "同じ内容で結果を確認"}
          </button>
          <Show when={canEditPending()}>
            <p>サーバーがこの内容を受け付けなかったため、入力を直して新しい送信として試せます。</p>
            <button class="button button-quiet" type="button" onClick={editPendingInput}>
              入力内容を修正する
            </button>
          </Show>
        </section>
      </Show>

      <div class="section-rule" />

      <section class="manual-entry" aria-labelledby="manual-entry-title">
        <h3 id="manual-entry-title">手入力で記帳</h3>
        <form class="ledger-form" onSubmit={submitManual}>
          <label>
            区分
            <select
              value={manual().kind}
              disabled={locked()}
              onChange={(event) =>
                setManualField("kind", event.currentTarget.value as EntryInput["kind"])
              }
            >
              <option value="expense">出金</option>
              <option value="income">入金</option>
            </select>
          </label>
          <label>
            日付
            <input
              type="date"
              value={manual().occurredOn}
              disabled={locked()}
              required
              onInput={(event) => setManualField("occurredOn", event.currentTarget.value)}
            />
          </label>
          <label>
            金額（円）
            <input
              type="number"
              min="1"
              max="999999999999"
              step="1"
              inputmode="numeric"
              value={amount()}
              disabled={locked()}
              required
              onInput={(event) => setAmount(event.currentTarget.value)}
            />
          </label>
          <label>
            内容
            <input
              type="text"
              maxlength="500"
              value={manual().description}
              disabled={locked()}
              onInput={(event) => setManualField("description", event.currentTarget.value)}
              placeholder="例：会費、文具"
            />
          </label>
          <Show when={selectedFile()}>
            <p class="attachment-note">選択中の画像を証憑として一緒に保存します。</p>
          </Show>
          <Show when={formError()}>
            <p class="form-error" role="alert">
              {formError()}
            </p>
          </Show>
          <button class="button button-primary full-width" type="submit" disabled={locked()}>
            手入力で記帳する
          </button>
        </form>
      </section>
    </section>
  );
}
