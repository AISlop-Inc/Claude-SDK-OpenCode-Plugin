> AISlop-Inc npm package: `@aislop-inc/claude-agent-opencode`.
> Manual release instructions: [npm publishing](docs/NPM-PUBLISHING.md).

# claude-agent-opencode

Claude Agent SDK を OpenCode V2 のモデルプロバイダとして使うプラグインです。
プラグインがローカルの OpenAI Chat Completions 互換 API を起動し、モデル一覧を自動登録します。

```text
OpenCode → OpenAI-compatible provider → localhost bridge → Claude Agent SDK
    ↑                                      ↓
    └──── ツール呼び出しを返す・実行結果を渡す ────┘
```

## セットアップ

OpenCode 2.2.5、Node.js 22.18 以上を使用してください。
このプラグインを使う OS ユーザーで Claude Code の認証を済ませてください。
認証は SDK に任せ、プラグイン内へトークンをコピーしません。
API キーや Bedrock / Vertex 等の環境変数も SDK に引き継ぐため、接続先は OpenCode サーバーの環境に従います。

```sh
git clone https://github.com/AISlop-Inc/Claude-SDK-OpenCode-Plugin.git ~/.local/share/opencode/claude-agent-opencode
cd ~/.local/share/opencode/claude-agent-opencode
npm ci
npm run build
npm run auth -- status
npm run usage
```

未ログインの場合は `npm run auth -- login` で SDK 同梱の Claude Code にログインできます。
このコマンドは本人のターミナルで実行してください。

## AI エージェントにインストールさせる

次のように依頼してください。

> https://github.com/AISlop-Inc/Claude-SDK-OpenCode-Plugin の AGENTS.md に従ってインストールして。
> 既存の OpenCode 設定を保持してプラグインを追加し、認証状態とモデル一覧まで確認して。
> 実接続テストは許可した場合だけ Haiku で行って。

[AGENTS.md](./AGENTS.md) に、前提環境、認証、設定の追記、テスト、更新・削除の手順をまとめています。

## OpenCode に登録

利用するプロジェクトの `opencode.json`、または `~/.config/opencode/opencode.json` の `plugins` に、このディレクトリを追加します。
既存の設定に追記してください。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/claude-agent-opencode"]
}
```

モデル選択から **Claude Agent SDK** を選びます。
設定は自動再読み込みされ、必要なら `/reload` で明示的に読み直せます。
モデル ID と推論強度の選択肢は SDK のカタログに従います。

```sh
opencode run -m claude-agent-sdk/claude-sonnet-5-5 'こんにちは'
opencode run -m 'claude-agent-sdk/claude-sonnet-5-5#high' 'このコードを確認して'
```

指定モデルがアカウントに存在しない場合は、モデル選択に表示された正式 ID に置き換えてください。

## 動作

- モデル名・コンテキスト上限・推論強度を SDK から取得
- テキスト、画像入力、関数ツール、JSON 応答、SSE ストリーミングに対応
- ツールは MCP として SDK に提示し、`PreToolUse` の `defer` で OpenCode に返却
- SDK の組み込みツール、プロジェクト設定、外部 MCP の自動読み込みを無効化
- OpenCode の組み込み指示は除外し、`AGENTS.md` 等の指示、エージェント指示、会話とツール履歴は転送する
- ツール実行と承認は OpenCode が担当
- キャンセル時に SDK を停止し、プラグイン解除時に HTTP サーバーを終了
- `127.0.0.1` の空きポートと、起動ごとのランダムな Bearer トークンを使用

画像は PNG/JPEG/GIF/WebP の base64 data URL、または HTTPS URL に対応します。
画像の取得と解釈は SDK 側に任せます。

## 現在の制限

- OpenCode の指示元メタデータは実験的 API です。OpenCode のバージョンにより分類が変わる可能性があります。
- 同一セッション内で履歴と設定が一致する場合、通常回答後も SDK セッションを再開し、新しいユーザー発言またはツール結果だけを引き渡します。
  完了回答に複数のユーザー発言が続いた場合も、すべてを保持したまま差分で渡します。
  複数のツール結果は呼び出しIDで照合し、同じ結果の二重返却を拒否します。
  ただしSDKの[defer契約](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)は1モデルターンの単一呼び出しが対象です。
  複数結果のID照合テストは、SDKによる並列呼び出し保留の実接続保証ではありません。
  履歴編集・圧縮・分岐・設定変更、画像付きツール結果など、条件に合わない場合は会話全体を JSON の履歴として再送します。
  これはネイティブの assistant / tool 履歴と同一の表現ではありません。
- SDK セッションの再開にはディスクへの保存が必要です。
  Claude Code は会話内容を通常の SDK セッション保存先（`~/.claude/projects/` または設定された保存先）に書き込みます。
  ツール定義と結果を含む一時ファイルはアクセスを制限した一時ディレクトリに置き、継続情報の破棄またはプラグイン終了時に削除します。
  継続情報はメモリ内に保持するため、プラグイン再読込後は再構築します。
  強制終了時には一時ファイルが残る場合があります。
- Haikuを使った単一ツールの実接続テストでは、再開時のキャッシュ読み取りを確認しました。
  通常回答後の継続と複数結果の経路はSDKモック・ローカルMCP子プロセスで検証済みで、実アカウントでの推論は未検証です。
  実際の利用枠の削減率は環境やキャッシュ状態により異なり、未測定です。
- SDK カタログで取得するのはコンテキスト上限です。
  OpenCode に登録する最大出力は保守的に 32,000 トークンとし、実際の出力制限は SDK にも従います。
- `tool_choice` は `auto` と `none` に対応します。
  強制ツール指定、構造化出力、音声・動画・PDF 入力には対応していません。
- sampling temperature 等の SDK に直接対応しない生成設定は反映しません。
- thinking 本文は返さず、推論強度のみ渡します。
- モデル一覧の更新にはプラグインの再読み込みが必要です。

## 開発・検証

2026-11-07 に型チェック、ビルド、自動テストを確認しました。
組み込み指示とプロジェクト指示を分け、`AGENTS.md` 等を保持するようにしています。
実SDK/Claude Code子プロセスとローカルの偽Messages APIで、ツール結果と複数ユーザー発言の差分継続、完了result後に待ち続けないことを検証します。
実アカウントの認証情報や実推論は使用しません。

```sh
npm run typecheck
npm test
npm run build

# 実際の Claude 利用が発生する往復テスト
CLAUDE_SMOKE_MODEL=claude-haiku-5-5 npm run test:smoke

# SDK再開を使う比較用の実接続テスト（事前にnpm run buildが必要）
CLAUDE_SMOKE_MODEL=claude-haiku-5-5 npm run test:resume-smoke
# 同じ入力を全履歴送信で比較
NO_RESUME=1 CLAUDE_SMOKE_MODEL=claude-haiku-5-5 npm run test:resume-smoke

# OpenCode 本体からの確認
cd examples/smoke
opencode run --standalone -m claude-agent-sdk/claude-haiku-5-5 \
  'Use the read tool to read ./sentinel.txt, then reply with only its contents.'
```

`src/protocol.ts` が入力検証と履歴変換、`src/agent.ts` が SDK 呼び出し、`src/server.ts` が HTTP/SSE、`src/index.ts` が OpenCode の登録とライフサイクルを担当します。

GitHub Actions を使う場合は `examples/github-actions-test.yml` を `.github/workflows/test.yml` に配置してください。
このCI例は実アカウントを使わず、型チェック・自動テスト・日次収集スクリプトのテスト・ビルドを実行します。

## 日次フィードバック

各ターンのビルド識別子・モデル・lane・継続方法・再構築理由・所要時間・入力/cache作成/cache読取/出力を `~/.local/share/opencode/claude-feedback/` にJSONLで記録します。
本文や認証情報は記録しません。
システム指示・MCPツール定義・OpenCode側の履歴・新規ツール結果は、UTF-8バイト数とSHA-256だけを記録します。
これらはプラグイン境界の計測で、SDKが追加する指示・ツールを含むAPIリクエスト全体のサイズではありません。
`sameModelPayloads` は成功したprimaryのresumeだけを集計し、モデル切り替え等のbootstrapとエラーを除外します。
計測追加前のログは欠測として扱います。
同一ハッシュの種類数には複数会話・モデルの違いも含むため、それだけでは同一会話のキャッシュ破壊と判定しません。
`OPENCODE_CLAUDE_FEEDBACK_DIR` で保存先を変更できます。
`node dist/feedback.js` は直近24時間を集計し、利用量が取得できなかったリクエストを区別します。
`sentBytes` は履歴・新規メッセージ・結果のローカル送信量で、システム指示やツール定義を含む通信全体やモデルの消費トークン数ではありません。

```sh
python3 scripts/daily-feedback.py --node /absolute/path/to/node \
  --opencode /absolute/path/to/opencode --model provider/non-claude-model --collect-only
```

`--collect-only` を外すと、使用量照会と集計に続いてOpenCodeの独立プロセスで保守を実行します。
`scripts/feedback-prompt.txt` に沿って原因確認・修正・テスト・PR・通常のマージ・ローカル更新を行い、問題がなければ確認結果だけを残します。
同時実行はファイルロックで防ぎ、保守は1時間でタイムアウトします。
再構築理由は `model-changed`・`settings-changed`・`history-changed`・`assistant-changed`・`unsupported-append` に分けます。
長い会話へのモデル切り替えに伴う初回投入は正常な再構築として扱い、不要な再投入とは区別してください。
JSONオブジェクトのキー順序だけの差は継続を妨げず、MCPのスキーマもキー順序を安定させます。
指示や配列の順序、設定値の変更は無視しません。
スナップショット、前回への参照、保守ログ、終了状態は同じ保存先に残ります。
使用量照会は推論を送らず、保守には指定した非Claudeモデルを使用してください。
macOSではLaunchAgentの `StartCalendarInterval` にHour=9、Minute=0を指定してこのコマンドを登録します（ホストの時刻帯が日本時間の場合）。
実行にはログイン済みのMacとネットワークが必要で、スリープ中の予定は復帰後に実行されます。
欠測や利用枠のリセット、他Claudeクライアントの利用を考慮し、日々の使用率差を削減率とは扱いません。

### 消費最適化の方針

Claude Codeの[キャッシュ仕様](https://code.claude.com/docs/en/prompt-caching)に合わせ、同じモデルでの安定したprefixと追記を優先します。
SDKのresumeもキャッシュを利用するため、プロセスの常駐化だけでトークン消費が減るとは扱いません。
キャッシュ読み取りも入力なので、送信バイト数やAPI料金の割引率からサブスク枠の削減率は算出しません。
ツール結果は履歴へ入る前に必要な範囲へ絞り、保存済みの履歴は毎ターン書き換えません。
長い会話の早期圧縮やモデル・推論強度の自動変更は、この最適化では行いません。

ツール結果プレビューは既定で無効です。
`options.toolResultMaxBytes=16384`または`OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES=16384`で明示的に有効化した場合、新規ツール結果が16KiBを超え、readツールが利用できるときだけ全文をアクセス制限付き一時ファイルへ保存し、SDKには上限内の先頭・末尾プレビューと取得先を渡します。
これはOpenCodeが実行済みの結果の受け渡しであり、SDK内でツールを実行したり承認を省略したりしません。
OpenCodeの保存済み会話・ユーザー発言・指示は変更せず、モデル切り替え時の既存履歴も書き換えません。
必要な詳細は、SDKが要求する通常のread呼び出しをOpenCodeで実行して取得します。
全文保存に失敗したときは結果を省略せず、元の全文を渡して`storageErrors`へ記録します。
非文字列の結果やreadがない会話は対象外です。
`OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES=0` で無効化でき、1024以上の整数で上限を変更できます。
OpenCodeのプラグイン設定の`options.toolResultMaxBytes`でも指定でき、環境変数より優先します。
例えばプラグイン登録を`{"package":"/absolute/path/to/claude-agent-opencode","options":{"toolResultMaxBytes":0}}`にすると、設定再読込でこのプレビューを無効化できます。
一時ファイルはSDK継続情報と同じ寿命で、セッション破棄・プラグイン終了時に削除します。
一時ファイルへ省略した内容の全文を保存するため、JSONL計測に本文を残さないことと、本文を一切保存しないことは異なります。
`toolResults` に実際の元サイズ・引き渡しサイズ・退避件数を記録します。
同じ継続ディレクトリの退避ファイルをreadで取得した回数も`retrievals`へ記録し、本文やパスはメトリクスへ残しません。
これらの差はその結果のインライン量であり、再取得の消費やサブスク枠の削減率を表しません。
再取得が増えれば、特に長い会話では総消費が増える可能性もあるため、退避量と再取得数・入力/cache読取/出力を合わせて評価してください。

`scripts/replay-tool-results.ts` は既存SDK JSONLをモデルへの推論なしで再生する検証用です。
観測済みの新規結果と、引き継いだ過去の結果を初回挿入時に制限したと仮定する場合を別々に出力します。
実運用では過去の履歴をこの再生結果で置き換えません。

[SDK ToolSearch](https://code.claude.com/docs/en/agent-sdk/tool-search)は候補ですが、このブリッジでは無効のままです。
有効化には内部の検索呼び出しだけをSDKで処理し、外部ツールは引き続きOpenCodeで承認・実行する専用処理と、複数の推論ラウンドへの対応が必要です。
単に環境変数を変更したり、全MCPツールを自動承認したりしないでください。

## 追加利用エラーの切り分け

`You're out of extra usage` は、通常のサブスク枠を使い切ったことを必ずしも意味しません。
SDKがHTTPステータスなしで返す `rate_limit` のうち、枠到達が明記されたエラーはHTTP 400（ストリーミング中はエラーコード400）として返し、OpenCodeによる5xx再試行を防ぎます。
通常のHTTP 429や一時的な通信障害は、この扱いには変更しません。
枠到達が一度確認されたモデルについては、同じプラグインサーバーで60秒間、補助リクエストをSDKへ送らずに同じエラーを返します。
対象はidentityなし、またはtitle/compaction/generateであり、primaryの明示的な再試行と別モデルは止めません。
拒否したリクエストで待機時間を延長せず、時間経過または同じモデルの成功で解除します。
メトリクスでは`reason: quota-cooldown`・`sdkStarted: false`・`sentBytes: 0`として、SDKを開始したエラーと区別します。

### セッション外の補助推論

OpenCodeの`Generate.text`（プラグインの`ctx.generate.text`を含む）は、セッションの`model.request`フックを通りません。
そのためlaneがunknownでも、手動試験や異常なセッションと断定できません。
例えばopencode-memのV2互換クライアントは、メモリ抽出等の補助推論をこの経路で実行します。
ホストが付けた`x-opencode-session`はハッシュだけを`hostRequest`へ記録し、同じホストIDで繰り返された受信を追跡します。
unknownの件数、補助推論の論理呼び出し数、HTTP再試行、SDK開始数は別の指標です。
`sdkStarted`はSDK query関数の開始であり、SDK内部の推論・再試行回数や課金回数ではありません。
古いログにはこれらの項目がないため、未計測をゼロ回開始として扱わないでください。
同梱の手動ブリッジ試験は`lane: test`として通常会話・補助推論と分離し、SDKモックを使う自動テストは通常のメトリクス保存先へ記録しません。
認証と現在の枠は別々に確認します。

```sh
npm run auth -- status
npm run usage
```

`usage` は SDK の利用状況照会 API を呼び、推論用のプロンプトを送信しません。
`utilization` は使用率の百分率、`resets_at` はタイムゾーン付きのリセット時刻です。
API キー等の接続では `available: false` になることがあります。
この照会 API は SDK の実験的 API のため、SDK 更新時に動作確認が必要です。
出力を公開する場合はアカウント情報や個人の利用状況を含めないでください。

### Haiku 5.5 での実測（2026-11-04）

同じ OS ユーザー・Claude.ai 認証・SDK 0.3.318 で比較しました。
試験時は通常枠に余裕があり、追加利用は無効でした。
入力の本文と認証情報はこのリポジトリには含めていません。

| 条件 | 結果 |
| --- | --- |
| 短い入力 → echo ツールをクライアントで実行 → 最終回答 | 成功 |
| 短い入力、最大出力 32,000、推論強度の指定なし | 成功 |
| OpenCode の実リクエスト（システム指示＋13ツール） | HTTP 400、追加利用エラー |
| 同じ実リクエストを OpenCode/Bun の外で Node.js から再送 | 同じエラー |
| 元のシステム指示だけを残し、ツール定義を外す | 同じエラー |
| 元の13ツールを残し、システム指示なしの短いテストにする | 成功 |
| 元のシステム指示と同じ46,157文字の一般的なテスト指示、ツールなし | 成功。入力15,858トークン |
| 元の実リクエストの全指示を公式 `claude_code` プリセットに append | 同じエラー |

同じ文字数でも内容によって成否が変わりました。
文字数とトークン数は同じではないため、厳密な同一トークン数での比較ではありません。
成功した一般指示の試験では SDK が `rateLimitType: five_hour`、`isUsingOverage: false` を返し、通常枠での利用を確認できました。
少なくとも認証の失敗、Bun 固有の不具合、ツール数だけ、最大出力だけでは今回の差を説明できません。
追加利用に分類される内部条件や、特定の指示が原因かどうかは未確認です。
OpenCode の組み込み指示を除外する一方、プロジェクトやユーザーが指定した指示は保持します。

公式ヘルプの [SDK とサブスクの説明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) は、Claude プランでログインした SDK が通常枠を使うと説明しています。
一方、[第三者ツールの認証に関する説明](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) は、第三者ツールが追加利用に振り分けられる場合があると説明しています。
したがって、SDK のログイン成功や短い smoke test の成功だけでは、OpenCode 全体を通常枠で利用できるとは保証できません。
プラグインは API キーを設定したり追加利用を有効化したりしません。
既に有効な追加利用を使うかどうかを含め、実際の課金先は SDK と Anthropic 側の判定に従います。
解消の確認は、通常枠の確認と OpenCode 本体の read 往復テストの両方で行ってください。

## 参考

- [codex-opencode-router](https://github.com/mattyatea/codex-opencode-router) の `src/provider/claude_agent.ts` — MCP でのツール提示、実行前の defer、モデルの動的取得
- [OpenCode V2 Server plugins](https://opencode.ai/v2/docs/build/plugins/server)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)

## ライセンス

[MIT](./LICENSE) — Copyright (c) 2026 AISlop-Inc

## npm installation

After the first npm publication, add this entry to the existing OpenCode plugins array:

```json
{"plugins": ["@aislop-inc/claude-agent-opencode@latest"]}
```

Do not add it alongside a local copy of the same plugin.
