# zandaka

日本円の共同資金台帳です。資金ごとにUUIDの共有URLを発行し、URLを知っている人はログインなしで入出金の閲覧・追加・編集・削除と証憑画像の閲覧ができます。共有URL自体が権限です。URLを知る人は誰でも記録や画像を変更・削除でき、アカウント、個人ごとの権限、共有URLの失効機能はありません。公開の資金一覧もありません。

## 開発環境

- Bun 1.4.4
- Node.js 24以上（CIは `.node-version` の24.22.1に固定）

依存関係をインストールします。

```sh
bun install
```

### ローカルの秘密情報

`apps/web/.dev.vars` を作成し、ローカル開発用の値を設定してください。このファイルはGit管理外です。

```dotenv
MASTER_KEY=<ローカルで生成した32バイト以上のランダム値>
OPENROUTER_API_KEY=<OpenRouter APIキー>
```

`/admin` から `MASTER_KEY` を使って共有URLを発行します。マスターキーは資金URLの発行にだけ使い、台帳の共有・記帳には不要です。`OPENROUTER_API_KEY` は画像読取に使います。実際の値をソース管理や公開環境変数へ入れないでください。

### データベースと起動

Drizzle schemaからmigrationを生成し、WranglerのローカルD1へ適用します。

```sh
bun run db:generate
bun run db:migrate:local
```

Turboの対話プロンプトを非対話環境で扱う場合は `CI=true` を付けてください。Turbo TUIが必要な端末では `TURBO_UI=true` を指定できます。

```sh
CI=true bun run db:generate
CI=true bun run db:migrate:local
```

Webアプリを起動します。

```sh
bun run dev:web
```

ブラウザーで <http://localhost:3001> を開きます。ローカル開発ではWranglerのローカルD1/R2 bindingを使用します。

## 台帳の仕様

- 資金は `/f/<UUID>` の共有URLで開きます。ログインやユーザー登録はありません。
- 金額は日本円の整数です。入出金額は1〜999,999,999,999円、開始残高は-999,999,999,999〜999,999,999,999円です。残高がマイナスになる記帳もできます。
- 残高は開始残高と入出金の集計から計算し、更新のたびに残高を上書きしません。D1の整数集計をBigIntで扱い、APIでは正確な10進文字列を返します。浮動小数への丸めはせず、SQLite整数集計の範囲を超える場合はエラーになります。
- 画像はJPEG、PNG、WebPの最大5 MiBを受け付けます。画像欄へのドラッグ＆ドロップ、またはファイル選択で直ちに読み取り、日付・区分・金額がすべて確定した結果を候補確認なしでまとめて記帳します。元画像はprivate R2へ証憑として保存し、記録一覧に最大480pxの画像を縦横比を保って直接表示します。画像クリックで原画像も開けます。記帳後は一覧から編集・削除できます。1件でも必須項目が不明な場合や読取失敗時は何も保存せず、選択画像を保持して下の手入力欄で証憑付き記帳ができます。保存結果が不明な場合は、同じ送信ID・内容で結果を確認し、二重記帳を防ぎます。
- 画像読取では画像データがOpenRouterおよびモデル提供者へ送信されますが、共有URLは送信しません。使用モデルは `z-ai/glm-5.3-flash`、推論強度は `high` に固定され、別モデルへのfallbackや自動retryはありません。OpenRouterの実キーと利用可能なcreditが必要です。キー未設定時は読取に失敗し、手入力と証憑保存は利用できます。
- Worker内ではAI SDKの `generateText` と `Output.object({ schema })`、OpenRouter providerを使用します。共通Zod schemaから出力型とJSON Schemaを得て、日付・金額・件数を実行時にも検証します。推論はOpenRouter側で実行され、検証済みの結果だけを自動記帳に使います。
- 画像読取にはlocation単位の近似レート制限があります。これは全世界で厳密な利用量上限を保証するものではありません。別途OpenRouter側でAPIキーの利用上限・credit上限を設定してください。
- 最後の記録が削除された証憑は削除を試行します。削除失敗や未確定のアップロードはcleanup対象として保持され、未参照の未確定画像は24時間後に回収されます。cleanup Workerは毎時17分に実行する設定です。

## 検証

ブラウザテストの初回はChromiumをインストールします。整形を書き換える場合は `bun fmt`、差分だけを検査する場合は `bun fmt:check` を使います。

```sh
bunx playwright install chromium
bun fmt:check
bun check
bun run test:api
bun run build
bun run test:e2e
```

APIテストはNodeのテストランナーと実Miniflare D1/R2を使い、金額・競合・再送・証憑の境界を検証します。各テストの制限時間は60秒です。

ブラウザテストはPlaywright Chromiumで実画面を操作します。専用の `127.0.0.1:3107` でアプリとメモリ内D1/R2を起動し、終了時に破棄します。既存サーバーは再利用せず、通常開発の3001番ポート、`.dev.vars`、ローカルWranglerデータには触れません。画像の正常読取応答のみ検証用データに置き換え、記帳・再送・証憑保存と取得は実際のアプリ経路を使います。キャッシュ済みページの編集・削除後に再訪しても、古い内容や削除済み記録が表示されないことを検証します。テスト自身の自動retryはありません。

CIはPR、mainへのpush、手動実行で、Ubuntu 24.04・Node 24.22.1・Bun 1.4.4を使用します。frozen install、整形、型・lint、APIテスト、build、ブラウザテストを順に実行します。失敗時のブラウザ画像・traceは3日間保持します。Renovateの自動マージは全検証成功と既存の `automerge` ラベルを条件とします。mainの必須チェック・ブランチ保護は設定しないため、このworkflow単独では手動マージや直接pushを禁止しません。

テストは実OpenRouterへ接続せず、Cloudflareアカウントや本番の秘密値も不要です。実際の画像読取には有効なOpenRouter APIキーと利用可能なcreditが必要です。ブラウザテストではPWA登録を無効にしており、本番Service Workerの動作やデプロイ済みCronの定期起動は別途確認が必要です。

## デプロイ

mainブランチへのpush後、CIのテストjobが成功した場合にだけ、本番へのデプロイjobが自動実行されます。Pull requestと手動のworkflow実行では本番へデプロイしません。デプロイはproduction stageへ適用され、新しいpushによって実行中のapplyをキャンセルせず、productionのdeploy jobを直列化します。

実行には、GitHub Actionsのrepository secrets、または `production` environment secretsとして、次の4つを登録してください。値をworkflowやソースコードへ書かないでください。

- `CLOUDFLARE_ACCOUNT_ID`: 対象CloudflareアカウントID
- `CLOUDFLARE_API_TOKEN`: 対象アカウント用API token
- `MASTER_KEY`: ランダムな値。UTF-8で32 bytes以上
- `OPENROUTER_API_KEY`: 画像読取に使うOpenRouter API key

GitHub CLIでrepository secretを設定する場合は、リポジトリのルートで1つずつ実行し、各コマンドの対話入力へ値を入力してください。secret値をコマンド引数やシェル履歴へ書きません。

```sh
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set CLOUDFLARE_API_TOKEN
gh secret set MASTER_KEY
gh secret set OPENROUTER_API_KEY
```

`production` environment secretsとして管理する場合は、先にGitHubリポジトリのSettingsで `production` environmentを作成し、各コマンドへ `--env production` を付けてください。どちらの方法でも、デプロイjobの実行前に4つすべてを登録する必要があります。未設定のsecretがある場合、deploy jobは事前検査で停止します。

Cloudflare tokenは対象アカウントをスコープとし、Workers、D1、R2およびAlchemy state-storeの操作に必要な権限を許可してください。Cloudflareの権限一覧には、関係する書込み権限として `Workers Scripts Edit`、`D1 Edit`、`Workers R2 Storage Edit`、`Secrets Store Write` が記載されています。Alchemyはaccount-levelの `alchemy-state-store` WorkerとSecretsStoreを作成または再利用します。これらは関連する権限名ですが、デプロイに必要な完全な最小権限セットとは確認できていません。アカウントの現在の権限一覧とAlchemyの操作要件を確認してください。詳しくは[Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)と[Secrets Storeの作成権限](https://developers.cloudflare.com/api/resources/secrets_store/subresources/stores/methods/create/)を参照してください。

ローカルのCloudflare API tokenでAlchemyを使う場合は、Git管理外の `packages/infra/.env` に必要な認証情報を設定できます。`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` はlocal profileの代わりに使う任意の項目です。`MASTER_KEY` と `OPENROUTER_API_KEY` は必須です。Alchemy stateはCloudflareアカウントのstate-store Worker/SecretsStoreに保持され、ローカルの `.alchemy` stateをCIへコピーする必要はありません。

通常はmain push後のworkflowに本番デプロイを任せてください。明示的に手動適用する場合は、意図するCloudflareアカウントとproduction設定を確認してから `packages/infra` で次を実行します。これはCloudflareへ本番変更を適用するコマンドです。

```sh
cd packages/infra
bun run deploy --stage production --yes --no-input
```

## パッケージ構成

```text
apps/web/          Solidの画面、ルーティング、Cloudflare Worker設定
packages/api/      oRPC API、台帳・証憑処理、OpenRouter画像読取
packages/db/       Drizzle schemaとD1 migrations
packages/infra/    AlchemyによるCloudflare Workers/D1/R2構成
packages/config/   共有TypeScript設定
```
