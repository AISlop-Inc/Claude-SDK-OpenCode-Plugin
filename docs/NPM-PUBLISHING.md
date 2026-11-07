# npm publishing

Package: `@aislop-inc/claude-agent-opencode` (public).

## First publish

1. Ensure npm organization `aislop-inc` exists and your account can publish to it.
2. Add a granular npm write token with bypass-2FA as the repository Actions secret `NPM_TOKEN`. Never commit it.
3. Open Actions → **Publish npm package** → **Run workflow**, branch `main`.
4. Keep `dry-run` checked to test the artifact; uncheck it to publish.

## Trusted Publishing

After the first publish, configure the package's npm Trusted Publisher:

- Provider: GitHub Actions
- Organization: `AISlop-Inc` (case-sensitive)
- Repository: `Claude-SDK-OpenCode-Plugin`
- Workflow filename: `publish-npm.yml`
- Environment: `npm-publish`
- Allow `npm publish` (not only staged publishing).

Remove `NPM_TOKEN` after OIDC works.
The workflow uses GitHub-hosted runners, Node 24 and npm >=11.5.1.
Only manual dispatch on main publishes; pushes and tags never publish.

## Subsequent releases

Commit a new `package.json` version (and package-lock.json if present), push to main, then run the workflow.
Published npm versions are immutable and cannot be reused.
The workflow does not change source, versions, tags or GitHub releases.
Dry-run does not verify npm write permissions or OIDC trust.

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers).
