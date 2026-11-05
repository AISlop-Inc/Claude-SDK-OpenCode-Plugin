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

export type Checkpoint = {
    sessionID: string;
    sdkSessionID: string;
    request: ChatRequest;
    assistant: Message;
};

function fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Return the single external tool result only when it continues this exact checkpoint. */
export function deferredResult(checkpoint: Checkpoint, sessionID: string, request: ChatRequest): Message | undefined {
    if (!sessionID || sessionID !== checkpoint.sessionID || !checkpoint.sdkSessionID) return;
    const { messages: before, stream: _previousStream, ...previousSettings } = checkpoint.request;
    const { messages, stream: _stream, ...settings } = request;
    if (fingerprint(settings) !== fingerprint(previousSettings)) return;
    if (messages.length !== before.length + 2) return;
    if (fingerprint(messages.slice(0, before.length)) !== fingerprint(before)) return;
    const assistant = messages[before.length];
    if (assistant.role !== 'assistant' || fingerprint(assistant) !== fingerprint(checkpoint.assistant)) return;
    if (assistant.tool_calls?.length !== 1) return;
    const result = messages[before.length + 1];
    if (result.role !== 'tool' || result.tool_call_id !== assistant.tool_calls[0].id) return;
    if (typeof result.content !== 'string') return;
    return result;
}
