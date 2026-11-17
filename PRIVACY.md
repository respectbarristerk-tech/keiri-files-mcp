# プライバシーポリシー（keiri-files-mcp）

- このツールは利用者のPC上だけで動きます。外部への通信を行うコードはありません（送信・収集・解析・広告なし）。
- 読み書きするのは、利用者が指定した「許可フォルダ」の配下だけです。書き込むのは `整理済み` フォルダ内のコピー・台帳（ledger.csv）・実行ログ（log.csv）・確認待ちの記録（確認待ち.csv）・freee 用CSVと、連絡用フォルダ `確認待ち` の質問ファイル（question_*.txt）、rename モードで指定したファイルの名前の変更、医療関係の領収書を `整理済み/医療関係` へ receipt_id の名前で移すことだけです。ファイルの削除はしません。メールの送信もしません。
- 連絡用フォルダの質問ファイルは、利用者が設定した場合に Muse などのパーソナルAIが読みます（Googleドライブ経由）。その際のデータの扱いは、そのサービスの規約・ポリシーに従います。質問ファイルにはカード番号や医療機関名を書かない作りにしています。
- `read_file` は、許可フォルダ内のレシート・請求書の中身（画像、またはPDFのテキスト／PDFファイル）を利用者のAIクライアントに渡します。文字の読み取りは利用者が使うAIクライアント（Claude、Codex、Gemini など）が行い、その際のデータの扱いは各AIサービスの規約・ポリシーに従います。
- ツールが返す一覧・命名案・台帳の内容は、利用者のAIクライアントに渡されます。
- 問い合わせ先: 公開リポジトリの Issues（公開後に記載）

## English (summary)
Runs locally only. No network access, no telemetry, no deletion. Reads and writes only inside the folders you allow (copies, ledger/log CSVs, a pending-confirmation CSV, freee CSVs and question files for a personal AI such as Muse, which reads them only if you set it up). No email sending. `read_file` passes document contents (images, PDF text or the PDF file) to your own AI client; reading is done by that client, under that service's policy.
