# npm publishing

Trusted Publishing is configured for this package. No NPM_TOKEN secret is needed.

## Release

1. Commit a new package.json version (and package-lock.json if present) to main.
2. Open Actions → **Publish npm package** → **Run workflow**, branch main.
3. Keep dry-run checked to validate without publishing; uncheck it to publish.

Pushes and tags never publish. Published npm versions are immutable.
Dry-run does not verify OIDC authorization; use a new version for a real publish.

## Trusted Publisher settings on npm

- Provider: GitHub Actions
- Organization: AISlop-Inc (case-sensitive)
- Repository: Claude-SDK-OpenCode-Plugin
- Workflow filename: publish-npm.yml
- Environment: npm-publish
- Allowed action: npm publish

The workflow uses GitHub-hosted runners, Node 24, npm >=11.5.1 and id-token: write.
After verifying OIDC publication, set npm Publishing access to
**Require two-factor authentication and disallow tokens**.

For a new package, publish the first version locally using npm login and 2FA,
then register its Trusted Publisher. Do not store a bootstrap token in GitHub.
New trust configurations must complete a publish within 2 days.

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers).
