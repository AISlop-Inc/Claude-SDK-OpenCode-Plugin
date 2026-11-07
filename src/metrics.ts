import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { conversation, type ChatRequest, type Usage } from './protocol.js';
import { toolCatalog } from './agent.js';

export const feedbackDirectory = process.env.OPENCODE_CLAUDE_FEEDBACK_DIR ?? join(homedir(), '.local/share/opencode/claude-feedback');
export type TurnMetric = {
    at: string; build: string; session: string | null; model: string; lane: string;
    mode: string; reason: string; durationMs: number; messageCount: number; toolCount: number;
    sentBytes: number; outcome: 'complete' | 'error' | 'cancelled'; usage?: Usage;
    hostRequest?: string;
    sdkStarted?: boolean;
    errorStatus?: number;
    payload?: {
        system: PayloadSize; tools: PayloadSize; history: PayloadSize;
        newToolResults: Array<PayloadSize & { tool: string }>;
    };
    toolResults?: { offloaded: number; originalBytes: number; deliveredBytes: number; storageErrors: number; retrievals?: number; limitBytes?: number };
};

type PayloadSize = { bytes: number; hash: string };

function measure(text: string): PayloadSize {
    return { bytes: Buffer.byteLength(text), hash: createHash('sha256').update(text).digest('hex') };
}

export function measurePayload(request: ChatRequest, appended?: ChatRequest['messages']): NonNullable<TurnMetric['payload']> {
    const transcript = conversation(request);
    // Without a continuation, only the trailing tool results are new, not every result in a cold history.
    const messages = appended ?? request.messages.slice(request.messages.findLastIndex((message) => message.role !== 'tool') + 1);
    return {
        system: measure(transcript.system),
        tools: measure(JSON.stringify(toolCatalog(request).tools)),
        history: measure(JSON.stringify(transcript.content)),
        newToolResults: messages.filter((message) => message.role === 'tool').map((message) => {
            const call = request.messages.flatMap((message) => message.tool_calls ?? []).find((call) => call.id === message.tool_call_id);
            return { ...measure(typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null)),
                tool: call?.function.name ?? 'unknown' };
        }),
    };
}

export async function buildFingerprint(): Promise<string> {
    const files = ['agent.js', 'server.js', 'continuation.js', 'protocol.js', 'mcp-stdio.js', 'metrics.js', 'tool-results.js', 'instructions.js', 'index.js'];
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
        sentBytes: number; durationMs: number; measuredUsage: number; input: number; cacheWrite: number; cacheRead: number; output: number;
        quotaBlocked: number; sdkStarts: number; sdkStartMeasured: number; hostIDsMeasured: number; distinctHostIDs: number; reasons: Record<string, number> }> = {};
    const hostIDs = new Map<string, Set<string>>();
    for (const metric of metrics) {
        const key = JSON.stringify([metric.build, metric.model, metric.lane]);
        const group = groups[key] ??= { requests: 0, errors: 0, cancelled: 0, resumed: 0, sentBytes: 0,
            durationMs: 0, measuredUsage: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0,
            quotaBlocked: 0, sdkStarts: 0, sdkStartMeasured: 0, hostIDsMeasured: 0, distinctHostIDs: 0, reasons: {} };
        group.requests++;
        group.quotaBlocked += Number(metric.reason === 'quota-cooldown');
        group.sdkStarts += Number(metric.sdkStarted === true);
        group.sdkStartMeasured += Number(metric.sdkStarted !== undefined);
        if (metric.hostRequest) {
            const ids = hostIDs.get(key) ?? new Set<string>();
            ids.add(metric.hostRequest);
            hostIDs.set(key, ids);
            group.hostIDsMeasured++;
            group.distinctHostIDs = ids.size;
        }
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

export function summarizePayloads(metrics: TurnMetric[]) {
    const continuations = metrics.filter((metric) => metric.lane === 'primary' && metric.mode.startsWith('resume-') && metric.outcome === 'complete');
    const measured = continuations.filter((metric) => metric.payload);
    const range = (values: number[]) => values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
    const results: Record<string, { count: number; bytes: number; maxBytes: number }> = Object.create(null);
    for (const metric of measured) {
        for (const result of metric.payload!.newToolResults) {
            const group = results[result.tool] ??= { count: 0, bytes: 0, maxBytes: 0 };
            group.count++;
            group.bytes += result.bytes;
            group.maxBytes = Math.max(group.maxBytes, result.bytes);
        }
    }
    const delivered = continuations.filter((metric) => metric.toolResults);
    return {
        sameModelContinuations: continuations.length, payloadMeasured: measured.length,
        missingPayload: continuations.length - measured.length,
        systemBytes: range(measured.map((metric) => metric.payload!.system.bytes)),
        toolDefinitionBytes: range(measured.map((metric) => metric.payload!.tools.bytes)),
        hostHistoryBytes: range(measured.map((metric) => metric.payload!.history.bytes)),
        distinctSystemHashes: new Set(measured.map((metric) => metric.payload!.system.hash)).size,
        distinctToolHashes: new Set(measured.map((metric) => metric.payload!.tools.hash)).size,
        newToolResults: results,
        deliveryMeasured: delivered.length,
        resultByteLimits: [...new Set(delivered.flatMap((metric) => metric.toolResults!.limitBytes === undefined ? [] : [metric.toolResults!.limitBytes]))].sort((a, b) => a - b),
        offloadedResults: delivered.reduce((sum, metric) => sum + metric.toolResults!.offloaded, 0),
        originalResultBytes: delivered.reduce((sum, metric) => sum + metric.toolResults!.originalBytes, 0),
        deliveredResultBytes: delivered.reduce((sum, metric) => sum + metric.toolResults!.deliveredBytes, 0),
        storageErrors: delivered.reduce((sum, metric) => sum + metric.toolResults!.storageErrors, 0),
        resultFileRetrievals: delivered.reduce((sum, metric) => sum + (metric.toolResults!.retrievals ?? 0), 0),
    };
}
