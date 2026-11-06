import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Usage } from './protocol.js';

export const feedbackDirectory = process.env.OPENCODE_CLAUDE_FEEDBACK_DIR ?? join(homedir(), '.local/share/opencode/claude-feedback');
export type TurnMetric = {
    at: string; build: string; session: string | null; model: string; lane: string;
    mode: string; reason: string; durationMs: number; messageCount: number; toolCount: number;
    sentBytes: number; outcome: 'complete' | 'error' | 'cancelled'; usage?: Usage;
};

export async function buildFingerprint(): Promise<string> {
    const files = ['agent.js', 'server.js', 'continuation.js', 'protocol.js', 'mcp-stdio.js'];
    const hash = createHash('sha256');
    for (const file of files) hash.update(await readFile(new URL(import.meta.url.endsWith('.ts') ? file.replace('.js', '.ts') : file, import.meta.url)));
    return hash.digest('hex').slice(0, 16);
}

export async function recordMetric(metric: TurnMetric, directory = feedbackDirectory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(join(directory, metric.at.slice(0, 10) + '.jsonl'), JSON.stringify(metric) + '\n', { mode: 0o600 });
}

export function summarizeMetrics(metrics: TurnMetric[]) {
    const groups: Record<string, { requests: number; errors: number; cancelled: number; resumed: number;
        sentBytes: number; durationMs: number; measuredUsage: number; input: number; cacheWrite: number; cacheRead: number; output: number; reasons: Record<string, number> }> = {};
    for (const metric of metrics) {
        const key = JSON.stringify([metric.build, metric.model, metric.lane]);
        const group = groups[key] ??= { requests: 0, errors: 0, cancelled: 0, resumed: 0, sentBytes: 0,
            durationMs: 0, measuredUsage: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasons: {} };
        group.requests++;
        group.errors += Number(metric.outcome === 'error');
        group.cancelled += Number(metric.outcome === 'cancelled');
        group.resumed += Number(metric.mode.startsWith('resume'));
        group.sentBytes += metric.sentBytes;
        group.durationMs += metric.durationMs;
        group.reasons[metric.reason] = (group.reasons[metric.reason] ?? 0) + 1;
        if (!metric.usage) continue;
        group.measuredUsage++;
        const read = metric.usage.prompt_tokens_details.cached_tokens;
        const write = metric.usage.prompt_tokens_details.cache_write_tokens ?? 0;
        group.input += metric.usage.prompt_tokens - read - write;
        group.cacheRead += read;
        group.cacheWrite += write;
        group.output += metric.usage.completion_tokens;
    }
    return groups;
}
