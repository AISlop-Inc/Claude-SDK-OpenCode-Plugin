import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { sdkOptions } from './agent.js';

const cwd = await mkdtemp(join(tmpdir(), 'opencode-claude-usage-'));
let stop!: () => void;
const stopped = new Promise<void>((resolve) => { stop = resolve; });
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
let active: ReturnType<typeof query> | undefined;

try {
    // No prompt is yielded: this sends a usage control request, not an inference request.
    active = query({
        prompt: (async function* () { await stopped; })(),
        options: { ...sdkOptions(cwd), abortController: controller },
    });
    const usage = await active.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const limits = usage.rate_limits;
    console.log(JSON.stringify({
        checkedAt: new Date().toISOString(),
        available: usage.rate_limits_available,
        fiveHour: limits?.five_hour ?? null,
        sevenDay: limits?.seven_day ?? null,
        extraUsage: limits?.extra_usage ?? null,
        modelScoped: limits?.model_scoped ?? null,
    }, null, 2));
} finally {
    clearTimeout(timeout);
    stop();
    active?.close();
    await rm(cwd, { recursive: true, force: true });
}
