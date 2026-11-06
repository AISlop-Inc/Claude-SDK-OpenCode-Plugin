import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { feedbackDirectory, summarizeMetrics, type TurnMetric } from './metrics.js';

const end = Date.now();
const start = end - 24 * 60 * 60 * 1000;
const metrics: TurnMetric[] = [];
let invalidLines = 0;
const dates = new Set([new Date(start).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10)]);
const files = await readdir(feedbackDirectory).catch((error) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
});
for (const file of files.filter((name) => dates.has(name.replace(/\.jsonl$/, '')) && name.endsWith('.jsonl'))) {
    for (const line of (await readFile(join(feedbackDirectory, file), 'utf8')).split('\n').filter(Boolean)) {
        try {
            const metric = JSON.parse(line) as TurnMetric;
            if (!Number.isFinite(Date.parse(metric.at)) || typeof metric.mode !== 'string' || !Number.isFinite(metric.sentBytes)) throw new Error('Invalid metric');
            if (Date.parse(metric.at) > start && Date.parse(metric.at) <= end) metrics.push(metric);
        } catch { invalidLines++; }
    }
}
console.log(JSON.stringify({ start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    observedRequests: metrics.length, invalidLines, groups: summarizeMetrics(metrics),
    limitations: ['Local SDK-bound payload bytes, not model input token savings.',
        'Errors may have consumed upstream tokens without returning usage.',
        'Quota includes other Claude clients; resets and workload differences prevent causal daily savings estimates.'] }, null, 2));
