// Offline replay: read an existing SDK JSONL without printing or copying conversation bodies.
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { boundToolResults } from '../src/tool-results.js';
import type { ChatRequest } from '../src/protocol.js';

const [file, directory] = process.argv.slice(2);
const replayBudgetBytes = 16 * 1024;
if (!file || !directory) throw new Error('Usage: tsx scripts/replay-tool-results.ts SDK.jsonl output-directory');
const inherited: ChatRequest['messages'] = [];
const added: ChatRequest['messages'] = [];
const text = (content: unknown): string | undefined => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content) || !content.every((part) => part?.type === 'text' && typeof part.text === 'string')) return;
    return content.map((part) => part.text).join('\n');
};
for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
    const record = JSON.parse(line);
    if (!['api-request-blob', 'user'].includes(record.type) || !Array.isArray(record.message?.content)) continue;
    for (const block of record.message.content) {
        if (record.type === 'user' && block.type === 'tool_result') {
            const content = text(block.content);
            if (content !== undefined) added.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
        }
        if (record.type !== 'api-request-blob' || block.type !== 'text') continue;
        let message;
        try { message = JSON.parse(block.text); } catch { continue; }
        if (message?.role !== 'tool') continue;
        const content = text(message.content);
        if (content !== undefined) inherited.push({ role: 'tool', tool_call_id: message.tool_call_id, content });
    }
}
await mkdir(directory, { recursive: true, mode: 0o700 });
const summaries = [];
for (const [sample, messages] of [['observed-new-results', added], ['inherited-results-hypothetical-first-insertion', inherited]] as const) {
    const result = await boundToolResults(messages, directory, replayBudgetBytes);
    summaries.push({ sample, count: messages.length, offloaded: result.offloaded, originalBytes: result.originalBytes,
        deliveredBytes: result.deliveredBytes, avoidedInlineBytes: result.originalBytes - result.deliveredBytes,
        storageErrors: result.storageErrors });
}
console.log(JSON.stringify({ mode: 'offline; no model inference', budgetBytes: replayBudgetBytes, summaries,
    limitations: ['Bytes are not model tokens or subscription quota savings.',
        'Inherited results were replayed hypothetically; existing history is not rewritten in production.'] }, null, 2));
