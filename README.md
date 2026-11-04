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
- ツール実行と承認は OpenCode が担当
- キャンセル時に SDK を停止し、プラグイン解除時に HTTP サーバーを終了
- `127.0.0.1` の空きポートと、起動ごとのランダムな Bearer トークンを使用

画像は PNG/JPEG/GIF/WebP の base64 data URL、または HTTPS URL に対応します。
画像の取得と解釈は SDK 側に任せます。

## 現在の制限

- 会話は毎回 JSON の履歴として渡します。
  SDK セッションの resume は使わず、ネイティブの assistant / tool 履歴と同一の表現ではありません。
  会話が長いほど入力が増えます。
- SDK カタログで取得するのはコンテキスト上限です。
  OpenCode に登録する最大出力は保守的に 32,000 トークンとし、実際の出力制限は SDK にも従います。
- `tool_choice` は `auto` と `none` に対応します。
  強制ツール指定、構造化出力、音声・動画・PDF 入力には対応していません。
- sampling temperature 等の SDK に直接対応しない生成設定は反映しません。
- thinking 本文は返さず、推論強度のみ渡します。
- モデル一覧の更新にはプラグインの再読み込みが必要です。

## 開発・検証

2026-11-04 に型チェック、ビルド、自動テストを確認しました。
SDK への実接続で、ツール呼び出しを HTTP クライアントへ返し、その実行結果を渡して最終回答を得る往復テストが成功しています。
OpenCode 2.2.5 本体でのプラグイン読み込みと SDK 接続も確認しましたが、本体経由のツール実行テストは追加利用エラー（HTTP 400）で未完了です。
通常のサブスク枠が残っていても再現するため、枠の回復だけで解消するとは限りません。
下記の切り分け結果を参照してください。

```sh
npm run typecheck
npm test
npm run build

# 実際の Claude 利用が発生する往復テスト
CLAUDE_SMOKE_MODEL=claude-haiku-5-5 npm run test:smoke

# OpenCode 本体からの確認
cd examples/smoke
opencode run --standalone -m claude-agent-sdk/claude-haiku-5-5 \
  'Use the read tool to read ./sentinel.txt, then reply with only its contents.'
```

`src/protocol.ts` が入力検証と履歴変換、`src/agent.ts` が SDK 呼び出し、`src/server.ts` が HTTP/SSE、`src/index.ts` が OpenCode の登録とライフサイクルを担当します。

GitHub Actions を使う場合は `examples/github-actions-test.yml` を `.github/workflows/test.yml` に配置してください。
この CI は実アカウントを使わず、型チェック・自動テスト・ビルドを実行します。

## 追加利用エラーの切り分け

`You're out of extra usage` は、通常のサブスク枠を使い切ったことを必ずしも意味しません。
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
OpenCode の実際の指示を削って動かす変更は採用していません。

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
