import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferredResult, requestIdentity, SessionQueue, type Checkpoint } from '../src/continuation.js';
import { requestSchema } from '../src/protocol.js';

const request = requestSchema.parse({ model: 'test', messages: [{ role: 'user', content: 'read' }],
    tools: [{ type: 'function', function: { name: 'read' } }] });
const assistant = { role: 'assistant' as const, content: null, tool_calls: [
    { id: 'call-1', type: 'function' as const, function: { name: 'read', arguments: '{"path":"a"}' } },
] };
const checkpoint: Checkpoint = { sessionID: 'session-a', sdkSessionID: 'sdk-a', request, assistant };
const result = { role: 'tool' as const, tool_call_id: 'call-1', content: 'contents' };
const next = requestSchema.parse({ ...request, messages: [...request.messages, assistant, result] });

test('identity requires a bounded session, agent and recognized lane', () => {
    const headers = { 'x-claude-opencode-session': 'ses_123', 'x-claude-opencode-agent': 'build', 'x-claude-opencode-kind': 'primary' };
    assert.deepEqual(requestIdentity(headers), { sessionID: 'ses_123', agent: 'build', kind: 'primary' });
    assert.equal(requestIdentity({ ...headers, 'x-claude-opencode-kind': 'other' }), undefined);
    assert.equal(requestIdentity({ ...headers, 'x-claude-opencode-session': '' }), undefined);
    assert.equal(requestIdentity({ ...headers, 'x-claude-opencode-session': 'x'.repeat(129) }), undefined);
    assert.equal(requestIdentity({}), undefined);
});

test('accepts only the exact session, history, settings, call and result', () => {
    assert.deepEqual(deferredResult(checkpoint, 'session-a', next), result);
    assert.equal(deferredResult(checkpoint, 'session-b', next), undefined);
    assert.equal(deferredResult(checkpoint, 'session-a', { ...next, model: 'other' }), undefined);
    assert.equal(deferredResult(checkpoint, 'session-a', { ...next, messages: [{ role: 'user', content: 'edited' }, assistant, result] }), undefined);
    assert.equal(deferredResult(checkpoint, 'session-a', { ...next, messages: [...request.messages, assistant, { ...result, tool_call_id: 'other' }] }), undefined);
    assert.equal(deferredResult(checkpoint, 'session-a', { ...next, messages: [...next.messages, { role: 'user', content: 'extra' }] }), undefined);
});

test('rejects altered, parallel or non-text tool results', () => {
    const changed = { ...assistant, tool_calls: [{ ...assistant.tool_calls[0], function: { ...assistant.tool_calls[0].function, arguments: '{}' } }] };
    assert.equal(deferredResult(checkpoint, 'session-a', { ...next, messages: [...request.messages, changed, result] }), undefined);
    const parallel = { ...assistant, tool_calls: [...assistant.tool_calls, { ...assistant.tool_calls[0], id: 'call-2' }] };
    assert.equal(deferredResult({ ...checkpoint, assistant: parallel }, 'session-a', { ...next, messages: [...request.messages, parallel, result] }), undefined);
    assert.equal(deferredResult(checkpoint, 'session-a', { ...next, messages: [...request.messages, assistant, { ...result, content: null }] }), undefined);
});

test('serializes primary requests by session and agent, while allowing separate sessions', async () => {
    const queue = new SessionQueue();
    const signal = new AbortController().signal;
    const first = { sessionID: 'a', agent: 'build', kind: 'primary' as const };
    const other = { ...first, sessionID: 'b' };
    const entered: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const start = (id: typeof first, label: string, wait = false) => Array.fromAsync(queue.run(id, signal, async function* () {
        entered.push(label);
        if (wait) await blocked;
        yield label;
    }));
    const a = start(first, 'a1', true);
    const b = start(first, 'a2');
    const c = start(other, 'b1');
    await c;
    assert.deepEqual(entered, ['a1', 'b1']);
    release();
    assert.deepEqual(await Promise.all([a, b]), [['a1'], ['a2']]);
    assert.deepEqual(entered, ['a1', 'b1', 'a2']);
});

test('a cancelled queued request never executes and does not block later requests', async () => {
    const queue = new SessionQueue();
    const identity = { sessionID: 'a', agent: 'build', kind: 'primary' as const };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = Array.fromAsync(queue.run(identity, new AbortController().signal, async function* () { await blocked; yield 1; }));
    const controller = new AbortController();
    const cancelled = Array.fromAsync(queue.run(identity, controller.signal, async function* () { throw new Error('must not execute'); yield 0; }));
    const last = Array.fromAsync(queue.run(identity, new AbortController().signal, async function* () { yield 3; }));
    controller.abort();
    release();
    assert.deepEqual(await Promise.all([first, cancelled, last]), [[1], [], [3]]);
});
