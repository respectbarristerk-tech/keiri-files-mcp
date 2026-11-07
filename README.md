# keiri-files-mcp（経理ファイル整理MCP）

## AIに貼る導入プロンプト
次の文をそのままAI（Claude Code／Codex／Gemini CLI など、ファイル操作ができるAI）に貼ってください。

```text
このリポジトリのREADMEとsrcを読んで、外部通信・削除・許可フォルダ外アクセスがないか要約してください。
問題なければ、私の環境（Claude Desktop／Claude Code／Codex 等）に合う導入手順を示し、私の承認を得てから実行してください。
許可フォルダには、レシート・請求書を置く専用のフォルダだけを指定してください。
```

---

PC内のレシート・請求書（PDF/画像）を、**あなたのAIが読み取った内容**をもとに

0. 中身をAIに見せる（`read_file`。JPG/PNGは画像、PDFは埋め込みテキスト）
1. 規則的なファイル名 `YYYYMMDD_取引先_金額_書類種別.拡張子` へコピー（またはリネーム）
2. 台帳CSV（UTF-8 BOM付き、Excelでそのまま開ける）へ追記
3. 日付・金額・取引先で検索

するローカルMCPサーバーです。

- 文字認識（OCR）はしません。`read_file` は画像やPDFのテキストをそのままAIに渡すだけで、読み取るのはあなたのAIです
- 外部通信なし・削除なし・子プロセスの実行なし。依存は公式MCP SDKと zod のみ（SDKが内部で依存する express 等のパッケージも .mcpb に同梱されますが、このツールのコードからは使っておらず、通信用のサーバーも起動しません）
- 許可したフォルダの外は読み書きしません（`../` やシンボリックリンクでの脱出も拒否）
- 書き込みを伴うツールは、AIクライアントの承認画面を通ります（ただし承認画面はクライアントの設定（自動承認など）によって出ないことがあります）

### 免責
- **ファイル名と一覧表を整える補助ツールです。電子帳簿保存法の要件を満たすことは保証しません。**
- 税務判断（勘定科目の確定、経費になるか等）はしません。読み取り結果と台帳の内容の確認は利用者の責任で行ってください。
- 本ソフトウェアは現状のまま提供され、利用によって生じた損害について作者は責任を負いません（LICENSE 参照）。

## ツール
| ツール | 内容 | 書き込み |
|---|---|---|
| `scan_folder(subdir?, recursive?)` | PDF/JPG/PNG/HEIC の一覧（相対パス、サイズ、更新日時、台帳登録済みか）。最大500件。`整理済み` は対象外。recursive の既定は true | なし |
| `read_file(path)` | 証憑1件の中身を返す。JPG/PNG → MCP の image（base64）。PDF → 埋め込みテキスト（下記）。HEIC は非対応（JPGに変換を案内）。画像は約3.7MB（base64で5MB）まで | なし |
| `propose_names(items[])` | 命名案と形式エラー（日付・金額・登録番号・書類種別）を返し、`plan_id` を発行。同名は `_2` 等で回避。日付・取引先・金額が同じもの（同じ依頼内・台帳の既存行）は `warnings` に「重複の可能性」 | なし |
| `apply_renames(plan_id, mode)` | `plan_id` の案だけ実行。既定 `copy` は `整理済み` へコピー。`rename` は元ファイル名を変更（上書きなし）。`整理済み/log.csv` に記録 | あり |
| `ledger_append(entries[], include_quotes?)` | `整理済み/ledger.csv` に追記。同じ証憑ファイル名、および実在しない証憑ファイル名（`整理済み` に無く、`log.csv` の copy/rename の記録先にも無いもの）は警告して追記しない。見積書は既定で追記しない（`include_quotes: true` で追記）。納品書は二重計上の注意つきで追記。日付・取引先・金額が同じ行は「重複の可能性」の警告つきで追記 | あり（追記のみ） |
| `search_ledger(date_from?, date_to?, amount_min?, amount_max?, vendor?)` | 条件を組み合わせて検索。件数・合計金額・該当行 | なし |

- `items` の各要素: `path`, `date`（YYYY-MM-DD）, `vendor`, `amount`（整数・円）, `doc_type`（領収書／請求書／見積書／納品書／その他）, `invoice_no`（任意、T＋13桁）
- 台帳の列: 日付, 支払先, 科目, 内容, 金額, 支払方法, インボイス有無, 登録番号, 証憑ファイル名, 事業割合(%), 書類種別, 元ファイル, 登録日時
  - インボイス有無は「あり」「なし」、事業割合は「50%」の形で書きます（Excel で開くと 0.5・パーセント表示として認識されます。未指定は空欄）。v0.3.0 までの「有」「無」の行もそのまま読み込み・重複判定に使えます
  - A〜J 列（日付〜事業割合）は、別売の台帳Excelにも貼れる並びです。台帳Excelへは A〜J 列（日付〜事業割合）だけをコピーして「経費」シートの5行目以降に値として貼ります。K列以降（書類種別・元ファイル・登録日時）は貼りません（台帳Excelの K列は台帳側の計算式です）
- `plan_id` はサーバーのメモリ上にだけあり、再起動で消えます。1つの `plan_id` は1回だけ実行できます
- 提案後に元ファイルが変更・移動された場合、その行は実行しません
- 登録番号は形式（T＋13桁）だけを確認します。実在の確認はしません
- 「重複の可能性」は日付・取引先・金額が同じときに出す警告です（取引先は前後の空白と全角/半角の違いを無視して比較）。エラーにはせず、止めるかどうかは利用者とAIが決めます
- 見積書は支払いの記録ではないため、`ledger_append` は既定で追記せず理由を警告で返します。台帳に入れたいときは `include_quotes: true` を指定します。納品書は同じ取引の請求書・領収書と二重計上になりうるため、追記したうえで注意を返します
- 取引先が Windows の予約名（CON, PRN, AUX, NUL, COM1〜9, LPT1〜9）になる場合は、先頭に `_` を付けます
- `rename` モードで整理したファイルも、`整理済み/log.csv` の記録先に実在すれば `ledger_append` で追記できます（記録先から移動・名前変更すると警告になります）

### read_file の PDF の返し方
- **埋め込みテキストを取り出せるPDF（パソコンで作った請求書など）は、テキストで返します。** 取り出しは依存を増やさない簡易版です（node:zlib のみ。FlateDecode・ASCII85・ASCIIHex、ToUnicode、オブジェクトストリームに対応）。配置は崩れることがあります
- **テキストが無いPDF（スキャン画像だけ等）や暗号化PDFは、PDFファイルそのものを MCP の resource（blob、application/pdf）で返します。** AIクライアントがPDFを表示できるかはクライアント次第です。表示できない場合は、JPG/PNGに変換してから読み取ってください（その旨を結果に書きます）
- 画像の縮小はしません（外部ライブラリを使わないため）。上限（約3.7MB）を超える画像はエラーで知らせます。**スマホの写真など大きい画像は、縮小してから（または解像度を下げて保存し直してから）読み取ってください**

### フォルダ構成（例）
```text
<許可フォルダ>/
  受信/                 ← レシート・請求書を置く
  整理済み/             ← ツールが作る
    20261001_架空商事テスト株式会社_55000_請求書.pdf
    ledger.csv          ← 台帳
    log.csv             ← 実行ログ
```

## 使い方の流れ（AI向けの手順は SKILL.md）
1. `scan_folder` で一覧を出す
2. AIが各ファイルを開いて日付・取引先・金額・書類種別・登録番号を読む（自信がない項目は利用者に聞く）
3. `propose_names` で命名案を作り、利用者が確認・承認する
4. `apply_renames` で実行（既定はコピー）
5. `ledger_append` で台帳に追記（科目・支払方法などは利用者が決める）
6. `search_ledger` で確認

## 導入
必要なもの: Node.js 20 以上。

```bash
npm ci
npm run build
npm test
```

起動は `node dist/index.js <許可フォルダ> [<許可フォルダ2> ...]` です。環境変数 `KEIRI_ALLOWED_DIRS`（Windows は `;`、macOS/Linux は `:` 区切り）でも指定できます。以下の `<...>` は自分の絶対パスに置き換えてください。Windows のパスは `/` 区切りで書いても動きます。

### Claude Desktop（.mcpb）
GitHub の Releases にある `keiri-files-mcp-<版>.mcpb` を使うか、自分で作ります。

```bash
npm ci
npm run build
npm test
npm run pack
```
`npm run pack`（scripts/pack-mcpb.mjs）は、一時フォルダに dist・manifest.json・README 等だけをコピーし、本番用の依存だけを入れて `keiri-files-mcp-<版>.mcpb` を作ります。開発用の依存（typescript、テスト用の架空証憑を作る pdfkit 等）は入りません。

できた `.mcpb` をダブルクリック（または Claude Desktop の設定画面にドラッグ）し、許可フォルダを選びます。v0.3.0 は Windows の Claude Desktop で導入と動作を確認済みです（macOS は未確認）。

### Claude Code
```bash
claude mcp add keiri-files -- node <keiri-files-mcpの場所>/dist/index.js <許可フォルダ>
```
**未確認**（コマンドの形式は公式ドキュメントに基づく）。

### Codex（~/.codex/config.toml）
```toml
[mcp_servers.keiri-files]
command = "node"
args = ["<keiri-files-mcpの場所>/dist/index.js", "<許可フォルダ>"]
```
**未確認。**

### Gemini CLI（~/.gemini/settings.json）
```json
{
  "mcpServers": {
    "keiri-files": {
      "command": "node",
      "args": ["<keiri-files-mcpの場所>/dist/index.js", "<許可フォルダ>"]
    }
  }
}
```
**未確認。**

## 安全のための設計
- パスは実パスに解決してから許可フォルダ配下かを判定します
- 一覧ではシンボリックリンクをたどりません
- コピーは既存ファイルを上書きしません（同名は `_2` 等）。リネームも上書きしません
- 台帳CSVは `=` `+` `-` `@` で始まる文字列の先頭に `'` を付け、Excelで数式として実行されないようにしています
- ソースは `src/` の数ファイルだけです。AIに読ませて確認できます

## 開発
- `npm test`: 単体テストと、SDKのMCPクライアントで架空の証憑10件を通す結合テスト（v0.2 の read_file・予約名・台帳の存在確認を含む）
- `node test/make_fixtures.mjs [日本語TTF] [欧文TTF]`: テスト用の架空の証憑10件（日本語のレシート画像6件・テキスト入りPDF4件、`test/fixtures/receipts`）と印字内容 `doc_texts.json` を作り直す。社名・宛名はすべて架空、登録番号は先頭0の架空番号です。pdfkit・pureimage・pngjs・jpeg-js は開発用（devDependencies）で、.mcpb には入りません

## English (summary)
A local MCP server that shows receipt/invoice contents to your AI (`read_file`: JPG/PNG as images, PDFs as embedded text or as a PDF resource), renames/copies the files (PDF/JPG/PNG/HEIC) to `YYYYMMDD_vendor_amount_type.ext` and appends rows to an Excel-friendly CSV ledger, based on what your own AI client read from the documents. No OCR, no network access, no deletion; it only touches the folders you allow. It is a helper for tidying file names and lists, not a guarantee of compliance with Japanese e-bookkeeping law, and it makes no tax decisions. License: MIT.
