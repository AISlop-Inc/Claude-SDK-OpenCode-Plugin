import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const command = process.argv[2] ?? 'status';
if (!['status', 'login', 'logout'].includes(command)) {
    throw new Error('Usage: npm run auth -- status|login|logout');
}

const require = createRequire(import.meta.url);
const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
let cli: string;
try {
    cli = require.resolve(`${platformPackage}/${executable}`);
} catch {
    cli = require.resolve(`${platformPackage}-musl/${executable}`);
}
const result = spawnSync(cli, ['auth', command], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
