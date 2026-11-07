import { createHash } from 'node:crypto';
import type { ChatRequest } from './protocol.js';

type Message = ChatRequest['messages'][number];

export type RequestIdentity = { sessionID: string; agent: string; kind: 'primary' | 'compaction' | 'generate' | 'title' };

export function requestIdentity(headers: Record<string, string | string[] | undefined>): RequestIdentity | undefined {
    const sessionID = headers['x-claude-opencode-session'];
    const agent = headers['x-claude-opencode-agent'];
    const kind = headers['x-claude-opencode-kind'];
    if (typeof sessionID !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionID)) return;
    if (typeof agent !== 'string' || agent.length > 1024) return;
    if (kind !== 'primary' && kind !== 'compaction' && kind !== 'generate' && kind !== 'title') return;
    try {
        const decoded = decodeURIComponent(agent);
        if (!decoded || decoded.length > 128) return;
        return { sessionID, agent: decoded, kind };
    } catch { return; }
}

export class SessionQueue {
    private readonly tails = new Map<string, Promise<void>>();

    async *run<T>(identity: RequestIdentity | undefined, signal: AbortSignal, execute: () => AsyncIterable<T>): AsyncGenerator<T> {
        if (!identity || identity.kind !== 'primary') {
            if (!signal.aborted) yield* execute();
            return;
        }
        const key = JSON.stringify([identity.sessionID, identity.agent]);
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const turn = new Promise<void>((resolve) => { release = resolve; });
        const tail = previous.then(() => turn);
        this.tails.set(key, tail);
        try {
            await previous;
            if (!signal.aborted) yield* execute();
        } finally {
            release();
            if (this.tails.get(key) === tail) this.tails.delete(key);
        }
    }
}

export type Checkpoint = {
    sessionID: string;
    sdkSessionID: string;
    request: ChatRequest;
    assistant: Message;
};

export function stableJSON(value: unknown): string {
    return JSON.stringify(value, (_, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

export function fingerprint(value: unknown): string {
    return createHash('sha256').update(stableJSON(value)).digest('hex');
}

export function rebuildReason(checkpoint: Checkpoint, request: ChatRequest): string {
    if (checkpoint.request.model !== request.model) return 'model-changed';
    const { messages: before, stream: _priorStream, ...priorSettings } = checkpoint.request;
    const { messages, stream: _stream, ...settings } = request;
    if (fingerprint(settings) !== fingerprint(priorSettings)) return 'settings-changed';
    if (fingerprint(messages.slice(0, before.length)) !== fingerprint(before)) return 'history-changed';
    if (messages.length <= before.length) return 'unsupported-append';
    if (fingerprint(messages[before.length]) !== fingerprint(checkpoint.assistant)) return 'assistant-changed';
    return 'unsupported-append';
}

export function continuation(checkpoint: Checkpoint, sessionID: string, request: ChatRequest):
    { kind: 'user' | 'tools'; messages: Message[] } | undefined {
    if (sessionID !== checkpoint.sessionID || !checkpoint.sdkSessionID) return;
    const { messages: before, stream: _priorStream, ...priorSettings } = checkpoint.request;
    const { messages, stream: _stream, ...settings } = request;
    if (messages.length <= before.length + 1) return;
    if (fingerprint(settings) !== fingerprint(priorSettings)) return;
    if (fingerprint(messages.slice(0, before.length)) !== fingerprint(before)) return;
    if (fingerprint(messages[before.length]) !== fingerprint(checkpoint.assistant)) return;
    const appended = messages.slice(before.length + 1);
    const calls = checkpoint.assistant.tool_calls ?? [];
    if (!calls.length) {
        if (appended.length && appended.every((message) => message.role === 'user')) return { kind: 'user', messages: appended };
        return;
    }
    const ids = new Set(calls.map((call) => call.id));
    if (ids.size !== calls.length || appended.length !== calls.length) return;
    for (const message of appended) {
        if (message.role !== 'tool' || typeof message.content !== 'string' || !message.tool_call_id || !ids.delete(message.tool_call_id)) return;
    }
    return { kind: 'tools', messages: appended };
}

/** Return the single external tool result only when it continues this exact checkpoint. */
export function deferredResult(checkpoint: Checkpoint, sessionID: string, request: ChatRequest): Message | undefined {
    const result = continuation(checkpoint, sessionID, request);
    return result?.kind === 'tools' && result.messages.length === 1 ? result.messages[0] : undefined;
}
