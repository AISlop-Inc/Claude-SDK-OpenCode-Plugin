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
OpenCode 2.2.5 本体でのプラグイン読み込みと SDK 接続も確認しましたが、本体経由のツール実行テストは Claude の追加利用枠不足（HTTP 400）で完了していません。
利用枠が回復したら、以下の OpenCode 本体のテストを再実行してください。

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

## 参考

- [codex-opencode-router](https://github.com/mattyatea/codex-opencode-router) の `src/provider/claude_agent.ts` — MCP でのツール提示、実行前の defer、モデルの動的取得
- [OpenCode V2 Server plugins](https://opencode.ai/v2/docs/build/plugins/server)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)

## ライセンス

[MIT](./LICENSE) — Copyright (c) 2026 AISlop-Inc
