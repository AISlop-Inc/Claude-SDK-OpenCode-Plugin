# AI エージェント向けガイド

## インストールを依頼された場合

1. `node --version`、`npm --version`、`opencode --version` を確認する。
   Node.js 22.18 以上、OpenCode 2.2.5 以上を使用する。
   バージョン管理ツールを使っている場合は、その環境で Node を選択する。
2. ユーザー指定の配置先を優先する。
   指定がなければ `~/.local/share/opencode/claude-agent-opencode` に clone する。
   同じ場所に既存のファイルがある場合は、Git remote と変更状態を確認してから再利用する。
   変更を破棄したり、別のリポジトリを上書きしない。

   ```sh
   git clone https://github.com/AISlop-Inc/Claude-SDK-OpenCode-Plugin.git ~/.local/share/opencode/claude-agent-opencode
   cd ~/.local/share/opencode/claude-agent-opencode
   npm ci
   npm run typecheck
   npm test
   ```

   `npm ci` の prepare で `dist/` がビルドされる。
   lifecycle scripts が無効なら `npm run build` を明示的に実行する。
3. 同じ OS ユーザー・環境で `npm run auth -- status` を実行する。
   これは SDK 同梱の Claude Code の認証状態を確認する。
   未ログインなら `npm run auth -- login` を本人のターミナルで実行してもらう。
   アカウント変更を依頼されていない限り、ログアウトしない。
   認証情報、API キー、認証状態のメールアドレスをリポジトリやログ成果物へ保存しない。
   API 接続用の環境変数があると、SDK の接続先はそれに従う。
   値を表示せず設定の有無を確認し、サブスク利用を希望する場合は接続先を本人と確認する。
4. プロジェクト限定の指定がなければ、ユーザーのグローバル `opencode.json` または `opencode.jsonc` に追加する。
   通常は `~/.config/opencode/`、`XDG_CONFIG_HOME` が設定されていればその配下を確認する。
   既存の JSONC コメント、設定、plugins の順序を保持し、同じプラグインを二重登録しない。
   次は追加する設定の形であり、既存ファイル全体を置き換える内容ではない。

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/absolute/path/to/claude-agent-opencode"]
   }
   ```

   `~` ではなく clone 先の絶対パスを使用する。
   別途 providers や固定ポートの設定は不要。
5. OpenCode のモデル選択に **Claude Agent SDK** が出ることを確認する。
   必要なら `/reload` を使う。
   モデル一覧は SDK から取得するため、アカウントに存在しない ID を固定で追加しない。
6. 実接続は Claude の利用枠を消費する。
   本人が実接続テストを許可した場合は **Haiku** を使う。
   `claude-haiku-5-5` が一覧にない場合は利用可能な Haiku の正式 ID に置き換える。

   ```sh
   CLAUDE_SMOKE_MODEL=claude-haiku-5-5 npm run test:smoke
   cd examples/smoke
   opencode run --standalone -m claude-agent-sdk/claude-haiku-5-5 \
     'Use the read tool to read ./sentinel.txt, then reply with only its exact contents. Do not use other tools.'
   ```

   本体テストでは、read が実行され、最終回答が `CLAUDE_AGENT_PLUGIN_OK_7193` になることを確認する。
   SDK 単体の成功と OpenCode 本体での成功は区別する。
   利用枠不足なら繰り返さず、エラーと未確認の範囲を報告する。
7. 配置先、変更した設定ファイル、認証状態、確認済みのテスト、残作業を簡潔に報告する。

## 更新・削除

- 更新前に `git status` を確認する。
  作業ツリーがクリーンなら `git pull --ff-only`、`npm ci`、`npm test` を実行する。
  OpenCode で `/reload` し、モデル一覧を確認する。
- 削除は設定から該当する plugins エントリだけを外す。
  プラグイン解除時にローカルサーバーは終了する。
  Claude Code の認証情報やセッションは削除しない。

## 開発

- `src/index.ts` は OpenCode の登録とライフサイクルを担当する。
- `src/server.ts` は HTTP/SSE、`src/protocol.ts` は入力検証と変換を担当する。
- `src/agent.ts` は SDK と MCP の境界を担当する。
  SDK 内ではツールを実行せず、PreToolUse の defer で OpenCode に返す。
- TypeScript は4スペース、シングルクォート、セミコロンあり。
- `npm run typecheck`、`npm test`、`npm run build` で確認する。
  自動テストで実アカウントを使用しない。
- README の既知の制限と検証状況を正確に保つ。
