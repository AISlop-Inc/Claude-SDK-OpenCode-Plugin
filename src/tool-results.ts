import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatRequest } from './protocol.js';

export const defaultToolResultBytes = 0;

export function toolResultLimit(value: unknown = process.env.OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES): number {
    // Keep full results unless explicitly opted in: an extra read can cost more than a smaller result saves.
    if (value === undefined) return defaultToolResultBytes;
    const limit = Number(value);
    if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) ||
        !Number.isSafeInteger(limit) || (limit !== 0 && limit < 1024)) {
        throw new Error('toolResultMaxBytes / OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES must be 0 or an integer >= 1024');
    }
    return limit;
}

/** Bound only results entering this SDK turn; never mutate the host's durable history. */
export async function boundToolResults(messages: ChatRequest['messages'], cwd: string, limit: number) {
    let offloaded = 0;
    let originalBytes = 0;
    let deliveredBytes = 0;
    let storageErrors = 0;
    const bounded: ChatRequest['messages'] = [];
    for (const message of messages) {
        if (message.role !== 'tool' || typeof message.content !== 'string') { bounded.push(message); continue; }
        const bytes = Buffer.from(message.content);
        originalBytes += bytes.length;
        if (!limit || bytes.length <= limit) {
            deliveredBytes += bytes.length;
            bounded.push(message);
            continue;
        }
        const hash = createHash('sha256').update(bytes).digest('hex');
        const path = join(cwd, 'tool-result-' + hash + '.txt');
        const marker = '\n[Tool result preview; middle omitted. Full result is ' + bytes.length + ' UTF-8 bytes. Exact full output saved to ' +
            JSON.stringify(path) + '. Use read with offset/limit, or search the file, before relying on omitted details.]\n';
        // A very long temporary path must not consume the entire preview budget.
        if (Buffer.byteLength(marker) >= limit) {
            deliveredBytes += bytes.length;
            bounded.push(message);
            continue;
        }
        try {
            await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                storageErrors++;
                deliveredBytes += bytes.length;
                bounded.push(message);
                continue;
            }
        }
        const remaining = limit - Buffer.byteLength(marker);
        let end = Math.ceil(remaining / 2);
        let start = bytes.length - Math.floor(remaining / 2);
        // Keep both the opening context and final status without splitting UTF-8 characters.
        while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
        const content = bytes.subarray(0, end).toString('utf8') + marker + bytes.subarray(start).toString('utf8');
        bounded.push({ ...message, content });
        deliveredBytes += Buffer.byteLength(content);
        offloaded++;
    }
    return { messages: bounded, offloaded, originalBytes, deliveredBytes, storageErrors, limitBytes: limit };
}
