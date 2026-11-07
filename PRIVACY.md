# プライバシーポリシー（keiri-files-mcp）

- このツールは利用者のPC上だけで動きます。外部への通信を行うコードはありません（送信・収集・解析・広告なし）。
- 読み書きするのは、利用者が指定した「許可フォルダ」の配下だけです。書き込むのは `整理済み` フォルダ内のコピー・台帳（ledger.csv）・実行ログ（log.csv）と、rename モードで指定したファイルの名前の変更だけです。ファイルの削除はしません。
- `read_file` は、許可フォルダ内のレシート・請求書の中身（画像、またはPDFのテキスト／PDFファイル）を利用者のAIクライアントに渡します。文字の読み取りは利用者が使うAIクライアント（Claude、Codex、Gemini など）が行い、その際のデータの扱いは各AIサービスの規約・ポリシーに従います。
- ツールが返す一覧・命名案・台帳の内容は、利用者のAIクライアントに渡されます。
- 問い合わせ先: 公開リポジトリの Issues（公開後に記載）

## English (summary)
Runs locally only. No network access, no telemetry, no deletion. Reads and writes only inside the folders you allow. `read_file` passes document contents (images, PDF text or the PDF file) to your own AI client; reading is done by that client, under that service's policy.
