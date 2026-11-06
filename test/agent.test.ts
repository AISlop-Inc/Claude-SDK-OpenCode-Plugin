import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { nodeCommand, runTurn, toolCatalog } from '../src/agent.js';
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
    assert.equal((await hook!({ hook_event_name: 'PreToolUse', tool_use_id: 'call-1', tool_name: alias })).hookSpecificOutput.permissionDecision, 'defer');
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

test('SDK receives append-stable transcript blocks', async () => {
    let received: unknown;
    const run = (({ prompt }: Parameters<typeof query>[0]) => Object.assign((async function* () {
        for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) received = message.message.content;
        yield { type: 'result', subtype: 'success', is_error: false, usage } as SDKMessage;
    })(), { close() {} })) as typeof query;
    await Array.fromAsync(runTurn(request, new AbortController().signal, run));
    assert.ok(Array.isArray(received));
    assert.equal(received.length, 2);
    assert.equal(JSON.parse(received[1].text).content[0].text, 'Read a file');
});

test('SDK result errors preserve upstream status', async () => {
    const mock = mockQuery([{ type: 'result', subtype: 'error_during_execution', is_error: true,
        api_error_status: 400, errors: ['out of extra usage'] }]);
    await assert.rejects(Array.fromAsync(runTurn(request, new AbortController().signal, mock.run)),
        (error: unknown) => error instanceof Error && 'status' in error && error.status === 400);
});

test('unavailable deferred tool is not reported as a successful tool call', async () => {
    const alias = [...toolCatalog(request).names.keys()][0];
    const mock = mockQuery([
        { type: 'assistant', parent_tool_use_id: null, message: { stop_reason: 'tool_use', content: [
            { type: 'tool_use', id: 'call-1', name: alias, input: {} },
        ] } },
        { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'tool_deferred_unavailable',
            stop_reason: 'tool_deferred', result: 'tool unavailable', usage },
    ]);
    await assert.rejects(Array.fromAsync(runTurn(request, new AbortController().signal, mock.run)), /tool unavailable/);
});

test('managed requests fail closed when the MCP tool server did not connect', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'opencode-mcp-test-'));
    const mock = mockQuery([{ type: 'system', subtype: 'init', mcp_servers: [{ name: 'opencode', status: 'failed' }] }]);
    try {
        await assert.rejects(Array.fromAsync(runTurn(request, new AbortController().signal, mock.run, {
            cwd, sessionID: 'session', save() { throw new Error('must not save'); },
        })), (error: unknown) => error instanceof Error && /tools could not connect/.test(error.message) &&
            'status' in error && error.status === 400);
    } finally { await rm(cwd, { recursive: true, force: true }); }
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

test('finds the newest installed Node when PATH has none', async () => {
    const home = await mkdtemp(join(tmpdir(), 'node-command-'));
    try {
        const installs = join(home, '.local/share/mise/installs/node');
        for (const version of ['9.11.2', '24.1.0', 'lts']) {
            await mkdir(join(installs, version, 'bin'), { recursive: true });
            await writeFile(join(installs, version, 'bin/node'), '');
        }
        assert.equal(nodeCommand(home, ''), join(installs, '24.1.0/bin/node'));

        const bin = join(home, 'bin');
        await mkdir(bin);
        await writeFile(join(bin, 'node'), '');
        assert.equal(nodeCommand(home, bin), join(bin, 'node'));
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
