import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { startServer } from '../src/server.js';
import { continuation } from '../src/continuation.js';
import { requestSchema } from '../src/protocol.js';
import { recordMetric, summarizeMetrics, type TurnMetric } from '../src/metrics.js';
import { toolCatalog } from '../src/agent.js';

test('equivalent schema objects produce identical MCP definitions for caching', () => {
    const build = (parameters: Record<string, unknown>) => toolCatalog(requestSchema.parse({ model: 'test',
        messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'read', parameters } }] })).tools;
    const first = build({ type: 'object', properties: { path: { type: 'string', description: 'Path' } }, required: ['path'] });
    const second = build({ required: ['path'], properties: { path: { description: 'Path', type: 'string' } }, type: 'object' });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.notEqual(JSON.stringify(first), JSON.stringify(build({ type: 'object', properties: { path: { type: 'number' } } })));
});

test('completed conversations resume with only the new user message, including no-tools requests', async () => {
    for (const tools of [[], [{ type: 'function', function: { name: 'read' } }]]) {
        const seen: Array<{ resume: string | undefined; prompt: string }> = [];
        const metrics: TurnMetric[] = [];
        const mock = (({ options, prompt }: Parameters<typeof query>[0]) => Object.assign((async function* () {
            assert.equal(options?.verbatimPrompts, true);
            assert.equal(options?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
            assert.equal(options?.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
            let text = '';
            if (typeof prompt !== 'string') for await (const message of prompt) text += JSON.stringify(message.message.content);
            seen.push({ resume: options?.resume, prompt: text });
            yield { type: 'assistant', parent_tool_use_id: null, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } } as SDKMessage;
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk-a',
                usage: { input_tokens: 1, output_tokens: 2 } } as SDKMessage;
        })(), { close() {} })) as typeof query;
        const server = await startServer(['test'], undefined, mock, async (metric) => { metrics.push(metric); });
        try {
            const headers = { authorization: 'Bearer ' + server.token, 'x-claude-opencode-session': 'ses_test',
                'x-claude-opencode-agent': 'build', 'x-claude-opencode-kind': 'primary' };
            const send = async (messages: unknown[]) => (await (await fetch(server.baseURL + '/chat/completions', {
                method: 'POST', headers, body: JSON.stringify({ model: 'test', tools, messages }),
            })).json()).choices[0].message;
            const messages = [{ role: 'user', content: 'old-history-' + 'x'.repeat(10_000) }];
            const assistant = await send(messages);
            await send([...messages, assistant, { role: 'user', content: 'new-message' }]);
            assert.equal(seen[1].resume, 'sdk-a');
            assert.match(seen[1].prompt, /new-message/);
            assert.doesNotMatch(seen[1].prompt, /old-history/);
            await send([{ role: 'user', content: 'edited-history' }]);
            assert.equal(seen[2].resume, undefined);
        } finally { await server.close(); }
        assert.deepEqual(metrics.map((metric) => metric.mode), ['bootstrap', 'resume-user', 'bootstrap']);
        assert.equal(metrics[2].reason, 'history-changed');
        assert.ok(metrics[1].sentBytes < metrics[0].sentBytes / 10);
    }
});

test('multiple external results are matched by ID, regardless of result ordering', () => {
    const request = requestSchema.parse({ model: 'test', messages: [{ role: 'user', content: 'read twice' }] });
    const assistant = { role: 'assistant' as const, content: null, tool_calls: ['a', 'b'].map((id) => ({
        id, type: 'function' as const, function: { name: 'read', arguments: '{}' },
    })) };
    const checkpoint = { sessionID: 'ses_a', sdkSessionID: 'sdk-a', request, assistant };
    const results = ['b', 'a'].map((id) => ({ role: 'tool' as const, tool_call_id: id, content: id }));
    const next = { ...request, messages: [...request.messages, assistant, ...results] };
    assert.deepEqual(continuation(checkpoint, 'ses_a', next), { kind: 'tools', messages: results });
    assert.equal(continuation(checkpoint, 'ses_a', { ...next, messages: [...request.messages, assistant, results[0], results[0]] }), undefined);
    assert.equal(continuation(checkpoint, 'ses_a', { ...next, model: 'different' }), undefined);
    assert.equal(continuation(checkpoint, 'other', next), undefined);
    assert.equal(continuation(checkpoint, 'ses_a', request), undefined);
    assert.equal(continuation(checkpoint, 'ses_a', { ...request, messages: [...request.messages, assistant] }), undefined);
});

test('large resumed results are offloaded without changing host history or the following continuation', async () => {
    const content = 'FULL_RESULT_SECRET\n'.repeat(5000);
    const metrics: TurnMetric[] = [];
    let queries = 0;
    let retainedFile = '';
    const mock = (({ options }: Parameters<typeof query>[0]) => Object.assign((async function* () {
        assert.equal(options?.verbatimPrompts, true);
        assert.equal(options?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
        assert.equal(options?.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
        const config = JSON.parse(await readFile(options!.env!.OPENCODE_CLAUDE_MCP_CONFIG!, 'utf8'));
        queries++;
        if (queries === 1) {
            const name = 'mcp__opencode__' + config.tools[0].name;
            yield { type: 'assistant', parent_tool_use_id: null, message: { stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'big-result', name, input: {} }] } } as SDKMessage;
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk-large',
                terminal_reason: 'tool_deferred', deferred_tool_use: { id: 'big-result' },
                usage: { input_tokens: 1, output_tokens: 1 } } as SDKMessage;
            return;
        }
        assert.equal(options!.resume, 'sdk-large');
        if (queries === 2) {
            const preview = config.results[0].content as string;
            assert.ok(Buffer.byteLength(preview) <= 16384);
            assert.match(preview, /Tool result preview/);
            retainedFile = JSON.parse(preview.match(/saved to (".*")\. Use read/)![1]);
            assert.equal(await readFile(retainedFile, 'utf8'), content);
            const name = 'mcp__opencode__' + config.tools[0].name;
            yield { type: 'assistant', parent_tool_use_id: null, message: { stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'fetch-result', name, input: { path: retainedFile, offset: 1, limit: 2 } }] } } as SDKMessage;
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk-large',
                terminal_reason: 'tool_deferred', deferred_tool_use: { id: 'fetch-result' },
                usage: { input_tokens: 1, output_tokens: 1 } } as SDKMessage;
            return;
        } else if (queries === 3) {
            assert.equal(config.results[0].id, 'fetch-result');
            assert.equal(config.results[0].content, content.slice(0, 64));
        } else assert.deepEqual(config.results, []);
        yield { type: 'assistant', parent_tool_use_id: null, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } } as SDKMessage;
        yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk-large',
            usage: { input_tokens: 1, output_tokens: 1 } } as SDKMessage;
    })(), { close() {} })) as typeof query;
    const server = await startServer(['test'], undefined, mock, async (metric) => { metrics.push(metric); }, 16384);
    try {
        const headers = { authorization: 'Bearer ' + server.token, 'x-claude-opencode-session': 'ses_large',
            'x-claude-opencode-agent': 'build', 'x-claude-opencode-kind': 'primary' };
        const send = async (messages: unknown[]) => {
            const response = await fetch(server.baseURL + '/chat/completions', { method: 'POST', headers,
                body: JSON.stringify({ model: 'test', tools: [{ type: 'function', function: { name: 'read' } }], messages }) });
            assert.equal(response.status, 200);
            return (await response.json()).choices[0].message;
        };
        const initial = [{ role: 'user', content: 'read a large result' }];
        const first = await send(initial);
        const history = [...initial, first, { role: 'tool', tool_call_id: 'big-result', content }];
        const second = await send(history);
        assert.equal(second.tool_calls[0].function.name, 'read');
        const retrieved = (await readFile(retainedFile, 'utf8')).slice(0, 64);
        const following = [...history, second, { role: 'tool', tool_call_id: 'fetch-result', content: retrieved }];
        const third = await send(following);
        await send([...following, third, { role: 'user', content: 'continue' }]);
        assert.equal(history[2].content, content);
        assert.deepEqual(metrics.map((metric) => metric.mode), ['bootstrap', 'resume-tools', 'resume-tools', 'resume-user']);
        assert.equal(metrics[1].toolResults?.offloaded, 1);
        assert.equal(metrics[1].toolResults?.originalBytes, Buffer.byteLength(content));
        assert.ok(metrics[1].toolResults!.deliveredBytes <= 16384);
        assert.equal(metrics[2].toolResults?.retrievals, 1);
        assert.doesNotMatch(JSON.stringify(metrics), /FULL_RESULT_SECRET|tool-result-[a-f0-9]+\.txt/);
    } finally { await server.close(); }
    await assert.rejects(readFile(retainedFile), /ENOENT/);
});

test('real MCP subprocess returns distinct results for identical tool arguments and refuses replay', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'claude-feedback-test-'));
    const path = join(cwd, 'config.json');
    await writeFile(path, JSON.stringify({ tools: [{ name: 'read', inputSchema: { type: 'object' } }],
        results: [{ id: 'a', name: 'read', content: 'first' }, { id: 'b', name: 'read', content: 'second' }] }));
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp-stdio.ts'],
        env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), OPENCODE_CLAUDE_MCP_CONFIG: path } });
    try {
        await client.connect(transport);
        assert.deepEqual((await client.callTool({ name: 'read', arguments: { __opencode_result_id: 'b' } })).content, [{ type: 'text', text: 'second' }]);
        assert.deepEqual((await client.callTool({ name: 'read', arguments: { __opencode_result_id: 'a' } })).content, [{ type: 'text', text: 'first' }]);
        await assert.rejects(client.callTool({ name: 'read', arguments: { __opencode_result_id: 'a' } }), /No matching external/);
        await assert.rejects(client.callTool({ name: 'read', arguments: {} }), /No matching external/);
    } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
});

test('metrics preserve missing usage and split cache from uncached input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-metrics-test-'));
    const metric: TurnMetric = { at: '2026-11-06T00:00:00Z', build: 'build', session: null, model: 'test', lane: 'primary',
        mode: 'resume-user', reason: 'exact-continuation', durationMs: 2, messageCount: 3, toolCount: 0,
        sentBytes: 20, outcome: 'complete', usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17,
            prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 } } };
    try {
        await recordMetric(metric, directory);
        assert.deepEqual(JSON.parse(await readFile(join(directory, '2026-11-06.jsonl'), 'utf8')), metric);
        const [summary] = Object.values(summarizeMetrics([metric, { ...metric, outcome: 'error', usage: undefined }]));
        assert.equal(summary.requests, 2);
        assert.equal(summary.errors, 1);
        assert.equal(summary.measuredUsage, 1);
        assert.equal(summary.input, 2);
        assert.equal(summary.cacheWrite, 3);
        assert.equal(summary.cacheRead, 8);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
