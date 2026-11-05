import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferredResult, type Checkpoint } from '../src/continuation.js';
import { requestSchema } from '../src/protocol.js';

const request = requestSchema.parse({ model: 'test', messages: [{ role: 'user', content: 'read' }],
    tools: [{ type: 'function', function: { name: 'read' } }] });
const assistant = { role: 'assistant' as const, content: null, tool_calls: [
    { id: 'call-1', type: 'function' as const, function: { name: 'read', arguments: '{"path":"a"}' } },
] };
const checkpoint: Checkpoint = { sessionID: 'session-a', sdkSessionID: 'sdk-a', request, assistant };
const result = { role: 'tool' as const, tool_call_id: 'call-1', content: 'contents' };
const next = requestSchema.parse({ ...request, messages: [...request.messages, assistant, result] });

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
