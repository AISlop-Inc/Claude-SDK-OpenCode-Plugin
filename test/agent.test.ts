import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runTurn, toolCatalog } from '../src/agent.js';
import { requestSchema } from '../src/protocol.js';

const request = requestSchema.parse({ model: 'test-model', messages: [{ role: 'user', content: 'Read a file' }],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }] });
const usage = { input_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 4 };

function mockQuery(messages: object[], inspect?: (options: Parameters<typeof query>[0]['options']) => void) {
    let closed = false;
    const run = (({ options }: Parameters<typeof query>[0]) => {
        inspect?.(options);
        return Object.assign((async function* () { yield* messages as SDKMessage[]; })(), { close() { closed = true; } });
    }) as typeof query;
    return { run, isClosed: () => closed };
}

test('SDK defers execution, returns original tool name and counts cache tokens', async () => {
    const alias = [...toolCatalog(request).names.keys()][0];
    let hook: Function | undefined;
    const mock = mockQuery([
        { type: 'assistant', parent_tool_use_id: null, message: { stop_reason: 'tool_use', content: [
            { type: 'tool_use', id: 'call-1', name: alias, input: { path: 'a' } },
        ] } },
        { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'tool_deferred', usage },
    ], (options) => {
        assert.deepEqual(options?.tools, []);
        assert.deepEqual(options?.settingSources, []);
        assert.equal(options?.strictMcpConfig, true);
        hook = options?.hooks?.PreToolUse?.[0].hooks[0];
    });
    const events = await Array.fromAsync(runTurn(request, new AbortController().signal, mock.run));
    assert.equal((await hook!()).hookSpecificOutput.permissionDecision, 'defer');
    assert.equal(events[0].type, 'tool');
    if (events[0].type === 'tool') assert.equal(events[0].call.function.name, 'read');
    assert.deepEqual(events[1], { type: 'done', reason: 'tool_calls', usage: {
        prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
    } });
    assert.equal(mock.isClosed(), true);
});

test('none disables thinking without changing other effort settings', async () => {
    for (const effort of ['none', 'minimal', 'high'] as const) {
        const mock = mockQuery([{ type: 'result', subtype: 'success', is_error: false, usage }], (options) => {
            assert.deepEqual(options?.thinking, effort === 'none' ? { type: 'disabled' } : undefined);
            assert.equal(options?.effort, effort === 'none' ? undefined : effort === 'minimal' ? 'low' : 'high');
        });
        await Array.fromAsync(runTurn({ ...request, reasoning_effort: effort }, new AbortController().signal, mock.run));
    }
});

test('SDK result errors preserve upstream status', async () => {
    const mock = mockQuery([{ type: 'result', subtype: 'error_during_execution', is_error: true,
        api_error_status: 400, errors: ['out of extra usage'] }]);
    await assert.rejects(Array.fromAsync(runTurn(request, new AbortController().signal, mock.run)),
        (error: unknown) => error instanceof Error && 'status' in error && error.status === 400);
});

test('partial text is not repeated in the assistant message', async () => {
    const mock = mockQuery([
        { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } } },
        { type: 'assistant', parent_tool_use_id: null, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }] } },
        { type: 'result', subtype: 'success', is_error: false, usage },
    ]);
    const events = await Array.fromAsync(runTurn(request, new AbortController().signal, mock.run));
    assert.equal(events.filter((event) => event.type === 'text').length, 1);
});

test('SDK error details survive and query is closed', async () => {
    const mock = mockQuery([{ type: 'assistant', parent_tool_use_id: null, error: 'unknown', message: {
        content: [{ type: 'text', text: 'Specific upstream failure' }],
    } }]);
    await assert.rejects(Array.fromAsync(runTurn(request, new AbortController().signal, mock.run)), /Specific upstream failure/);
    assert.equal(mock.isClosed(), true);
});
