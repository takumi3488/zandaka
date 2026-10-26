import { Title } from "@solidjs/meta";
import { useMutation } from "@tanstack/solid-query";
import { createSignal, Show } from "solid-js";

import { client } from "~/utils/orpc";

export default function Admin() {
  const [name, setName] = createSignal("");
  const [openingBalance, setOpeningBalance] = createSignal("0");
  const [masterKey, setMasterKey] = createSignal("");
  const [shareUrl, setShareUrl] = createSignal("");
  const [copyError, setCopyError] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal("");
  const createFund = useMutation(() => ({
    mutationFn: (input: { masterKey: string; name: string; openingBalanceYen: number }) =>
      client.funds.create(input),
    retry: false,
  }));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setErrorMessage("");
    setShareUrl("");
    const openingBalanceYen = Number(openingBalance());
    if (!Number.isInteger(openingBalanceYen) || Math.abs(openingBalanceYen) > 999_999_999_999) {
      setErrorMessage(
        "開始残高は−999,999,999,999円から999,999,999,999円までの整数で入力してください。",
      );
      return;
    }
    const fundName = name().trim();
    if (!fundName) {
      setErrorMessage("資金名を入力してください。");
      return;
    }
    try {
      const result = await createFund.mutate({
        masterKey: masterKey(),
        name: fundName,
        openingBalanceYen,
      });
      const url = new URL(`/f/${result.fundId}`, window.location.origin).toString();
      setShareUrl(url);
      setMasterKey("");
      setName("");
      setOpeningBalance("0");
      setCopyError(false);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "UNAUTHORIZED") {
        setErrorMessage("管理者キーが正しくありません。");
      } else if (code === "SERVICE_UNAVAILABLE") {
        setErrorMessage("資金を発行できません。管理者設定を確認してください。");
      } else {
        setErrorMessage("資金を発行できませんでした。入力内容を確認して再度お試しください。");
      }
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(shareUrl());
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <main class="page-shell narrow-page">
      <Title>資金を作成 | zandaka</Title>
      <header class="page-heading">
        <p class="section-kicker">管理者向け</p>
        <h1>共有する資金を作成</h1>
        <p>発行したURLを知っている人は、誰でもこの台帳を閲覧・編集できます。</p>
      </header>

      <section class="paper-section admin-section" aria-labelledby="create-fund-title">
        <h2 id="create-fund-title">資金の内容</h2>
        <form class="ledger-form" onSubmit={submit}>
          <label>
            資金名
            <input
              type="text"
              value={name()}
              maxlength="80"
              required
              autocomplete="off"
              onInput={(event) => setName(event.currentTarget.value)}
              placeholder="例：部活動費"
            />
          </label>
          <label>
            開始残高（円）
            <input
              type="number"
              value={openingBalance()}
              min="-999999999999"
              max="999999999999"
              step="1"
              inputmode="numeric"
              required
              onInput={(event) => setOpeningBalance(event.currentTarget.value)}
            />
          </label>
          <label>
            マスターキー
            <input
              type="password"
              value={masterKey()}
              required
              autocomplete="off"
              onInput={(event) => setMasterKey(event.currentTarget.value)}
            />
            <span class="field-help">マスターキーはこの端末の画面内だけで使い、保存しません。</span>
          </label>
          <Show when={errorMessage()}>
            <p class="form-error" role="alert">
              {errorMessage()}
            </p>
          </Show>
          <button class="button button-primary" type="submit" disabled={createFund.isPending}>
            {createFund.isPending ? "発行中…" : "共有URLを発行する"}
          </button>
        </form>
      </section>

      <Show when={shareUrl()}>
        <section class="paper-section share-result" aria-labelledby="share-result-title">
          <h2 id="share-result-title">共有URLを発行しました</h2>
          <p>このURLを共有すると、相手もすべての記録を閲覧・編集できます。</p>
          <label>
            共有URL
            <input
              type="url"
              readonly
              value={shareUrl()}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div class="button-row">
            <button class="button button-secondary" type="button" onClick={() => void copyUrl()}>
              URLをコピー
            </button>
            <a class="button button-primary" href={shareUrl()}>
              台帳を開く
            </a>
          </div>
          <Show when={copyError()}>
            <p class="field-help" role="status">
              コピーできない場合は、URL欄を選択してコピーしてください。
            </p>
          </Show>
        </section>
      </Show>
    </main>
  );
}
