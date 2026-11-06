import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { conversation, requestSchema, type TurnEvent } from '../src/protocol.js';
import { ClaudeError, neverExecute, toolCatalog } from '../src/agent.js';
import { startServer, type RunTurn } from '../src/server.js';

const payload = { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] };
const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } };

test('history preserves tool IDs, results and image attachments', () => {
    const request = requestSchema.parse({ ...payload, messages: [
        { role: 'system', content: 'System instruction' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'file contents' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
    ] });
    const result = conversation(request);
    assert.match(result.system, /System instruction/);
    const transcript = result.content.slice(1).filter((part) => (part as { type: string }).type === 'text')
        .map((part) => JSON.parse((part as { text: string }).text));
    assert.equal(transcript[0].tool_calls[0].id, 'call-1');
    assert.equal(transcript[1].tool_call_id, 'call-1');
    assert.deepEqual(result.content[4], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } });
});

test('appending messages preserves the complete previous content prefix including images', () => {
    const first = requestSchema.parse({ ...payload, messages: [
        { role: 'user', content: [{ type: 'text', text: '日本語\n"test"' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
    ] });
    const extended = requestSchema.parse({ ...first, messages: [...first.messages,
        { role: 'assistant', content: 'result' }, { role: 'tool', tool_call_id: 'call-1', content: 'output' }] });
    const previous = conversation(first).content;
    const next = conversation(extended).content;
    assert.deepEqual(next.slice(0, previous.length), previous);
    assert.equal(JSON.parse((next[1] as { text: string }).text).content[0].text, '日本語\n"test"');
    assert.equal(JSON.parse((next.at(-1) as { text: string }).text).tool_call_id, 'call-1');
});

test('user-provided system and developer instructions are retained', () => {
    const request = requestSchema.parse({ ...payload, messages: [
        { role: 'developer', content: 'Developer instruction' },
        { role: 'system', content: 'OpenCode system instruction' },
        { role: 'user', content: 'hello' },
    ] });
    const result = conversation(request);
    assert.match(JSON.stringify(result), /Developer instruction/);
    assert.match(JSON.stringify(result), /OpenCode system instruction/);
    assert.throws(() => conversation(requestSchema.parse({ ...payload, messages: [{ role: 'system', content: 'only system' }] })));
});

test('invalid/unsupported input fails instead of silently changing semantics', () => {
    assert.throws(() => requestSchema.parse({ ...payload, tool_choice: 'required' }));
    assert.throws(() => requestSchema.parse({ ...payload, response_format: { type: 'json_object' } }));
    assert.throws(() => conversation(requestSchema.parse({ ...payload, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///secret' } }] }] })));
});

test('tool aliases do not collide and SDK handlers cannot execute tools', async () => {
    const request = requestSchema.parse({ ...payload, tools: ['a.b', 'a_b'].map((name) => ({ type: 'function', function: { name } })) });
    const { tools, names } = toolCatalog(request);
    assert.notEqual(tools[0].name, tools[1].name);
    assert.equal(names.get('mcp__opencode__' + tools[0].name), 'a.b');
    assert.equal(toolCatalog({ ...request, tool_choice: 'none' }).tools.length, 0);
    await assert.rejects(neverExecute, /belongs to OpenCode/);
});

test('HTTP JSON and SSE preserve tool calls, usage and finish reason', async () => {
    const events: TurnEvent[] = [
        { type: 'text', text: 'Checking' },
        { type: 'tool', call: { index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } } },
        { type: 'done', reason: 'tool_calls', usage },
    ];
    const server = await startServer(['test-model'], async function* () { yield* events; });
    try {
        for (const stream of [false, true]) {
            const response = await fetch(server.baseURL + '/chat/completions', {
                method: 'POST', headers: { authorization: 'Bearer ' + server.token }, body: JSON.stringify({ ...payload, stream }),
            });
            assert.equal(response.status, 200);
            if (!stream) {
                const body = await response.json();
                assert.equal(body.choices[0].message.tool_calls[0].function.name, 'read');
                assert.equal(body.choices[0].finish_reason, 'tool_calls');
                assert.deepEqual(body.usage, usage);
            } else {
                const chunks = (await response.text()).trim().split('\n\n').map((line) => line.slice(6));
                assert.equal(chunks.pop(), '[DONE]');
                assert.equal(JSON.parse(chunks[1]).choices[0].delta.tool_calls[0].id, 'call-1');
                assert.equal(JSON.parse(chunks[2]).choices[0].finish_reason, 'tool_calls');
            }
        }
        assert.equal((await fetch(server.baseURL + '/models')).status, 401);
        const invalid = await fetch(server.baseURL + '/chat/completions', {
            method: 'POST', headers: { authorization: 'Bearer ' + server.token }, body: JSON.stringify({ ...payload, model: 'unknown' }),
        });
        assert.equal(invalid.status, 400);
    } finally {
        await server.close();
    }
});

test('authenticated HTTP requests pass valid session identity to the runner', async () => {
    let seen: unknown;
    const server = await startServer(['test-model'], async function* (_request, _signal, identity) {
        seen = identity;
        yield { type: 'done', reason: 'stop', usage };
    });
    try {
        const response = await fetch(server.baseURL + '/chat/completions', {
            method: 'POST', headers: { authorization: 'Bearer ' + server.token,
                'x-claude-opencode-session': 'ses_123', 'x-claude-opencode-agent': 'build', 'x-claude-opencode-kind': 'primary' },
            body: JSON.stringify(payload),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(seen, { sessionID: 'ses_123', agent: 'build', kind: 'primary' });
    } finally {
        await server.close();
    }
});

test('matching single-tool continuation resumes SDK with only the external result', async () => {
    const initial = requestSchema.parse({ ...payload, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
    const alias = [...toolCatalog(initial).names.keys()][0];
    let queries = 0;
    const queryFn = (({ options }: Parameters<typeof query>[0]) => Object.assign((async function* () {
        queries++;
        const config = JSON.parse(await readFile(options!.env!.OPENCODE_CLAUDE_MCP_CONFIG!, 'utf8'));
        const sdkUsage = { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 };
        if (queries === 1) {
            assert.equal(options!.resume, undefined);
            assert.deepEqual(config.results, []);
            yield { type: 'assistant', parent_tool_use_id: null, message: { stop_reason: 'tool_use', content: [
                { type: 'tool_use', id: 'call-1', name: alias, input: { path: 'a' } },
            ] } } as SDKMessage;
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk-session', terminal_reason: 'tool_deferred',
                deferred_tool_use: { id: 'call-1', name: alias, input: { path: 'a' } }, usage: sdkUsage } as SDKMessage;
        } else {
            assert.equal(options!.resume, 'sdk-session');
            assert.deepEqual(config.results, [{ id: 'call-1', name: alias.replace('mcp__opencode__', ''), content: 'external result' }]);
            const hook = options!.hooks!.PreToolUse![0].hooks[0];
            const decision = await hook({ hook_event_name: 'PreToolUse', tool_use_id: 'call-1', tool_name: alias } as never, 'call-1', {} as never);
            assert.equal(decision.hookSpecificOutput?.permissionDecision, 'allow');
            yield { type: 'assistant', parent_tool_use_id: null, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } } as SDKMessage;
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk-session', usage: sdkUsage } as SDKMessage;
        }
    })(), { close() {} })) as typeof query;
    const server = await startServer(['test-model'], undefined, queryFn);
    try {
        const headers = { authorization: 'Bearer ' + server.token, 'x-claude-opencode-session': 'ses_1',
            'x-claude-opencode-agent': 'build', 'x-claude-opencode-kind': 'primary' };
        const send = (body: object) => fetch(server.baseURL + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
        const first = await (await send(initial)).json();
        const assistant = first.choices[0].message;
        const second = await (await send({ ...initial, messages: [...initial.messages, assistant,
            { role: 'tool', tool_call_id: 'call-1', content: 'external result' }] })).json();
        assert.equal(second.choices[0].message.content, 'done');
        assert.equal(queries, 2);
    } finally { await server.close(); }
});

test('upstream errors never emit successful completion', async () => {
    const run: RunTurn = async function* () { yield { type: 'text', text: 'partial' }; throw new Error('upstream failed'); };
    const server = await startServer(['test-model'], run);
    try {
        for (const stream of [false, true]) {
            const response = await fetch(server.baseURL + '/chat/completions', {
                method: 'POST', headers: { authorization: 'Bearer ' + server.token }, body: JSON.stringify({ ...payload, stream }),
            });
            const body = await response.text();
            assert.match(body, /upstream failed/);
            assert.doesNotMatch(body, /\[DONE\]/);
            if (!stream) assert.equal(response.status, 502);
        }
    } finally {
        await server.close();
    }
});

test('disconnect cancels the in-flight SDK operation', async () => {
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const server = await startServer(['test-model'], async function* (_, signal) {
        const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }));
        yield { type: 'text', text: 'started' };
        await aborted;
    });
    try {
        const response = await fetch(server.baseURL + '/chat/completions', {
            method: 'POST', headers: { authorization: 'Bearer ' + server.token }, body: JSON.stringify({ ...payload, stream: true }),
        });
        await response.body!.cancel();
        await Promise.race([cancellation, new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('Cancellation timed out')), 2000);
            timer.unref();
        })]);
    } finally {
        await server.close();
    }
});

test('Claude quota rejection preserves HTTP 400 to avoid server-error retries', async () => {
    const server = await startServer(['test-model'], async function* () {
        throw new ClaudeError('unknown', "API Error: 400 You're out of extra usage.");
    });
    try {
        const response = await fetch(server.baseURL + '/chat/completions', {
            method: 'POST', headers: { authorization: 'Bearer ' + server.token }, body: JSON.stringify({ ...payload, stream: true }),
        });
        assert.equal(response.status, 400);
        assert.match(await response.text(), /out of extra usage/);
    } finally {
        await server.close();
    }
});

test('SDK subscription locks without HTTP status are non-retryable in JSON and SSE', async () => {
    assert.equal(new ClaudeError('rate_limit', 'API Error: 429 Too many requests').status, 429);
    assert.equal(new ClaudeError('unknown', 'network failed').status, 502);
    for (const stream of [false, true]) {
        const server = await startServer(['test-model'], async function* () {
            if (stream) yield { type: 'text', text: 'started' };
            throw new ClaudeError('rate_limit', "You've hit your 5-hour limit · resets 10:20am (Asia/Tokyo)");
        });
        try {
            const response = await fetch(server.baseURL + '/chat/completions', {
                method: 'POST', headers: { authorization: 'Bearer ' + server.token }, body: JSON.stringify({ ...payload, stream }),
            });
            if (stream) {
                const events = (await response.text()).split('\n\n').filter((line) => line.startsWith('data: '))
                    .map((line) => JSON.parse(line.slice(6)));
                assert.equal(events.at(-1).error.code, 400);
            } else {
                assert.equal(response.status, 400);
                assert.match(await response.text(), /5-hour limit/);
            }
        } finally { await server.close(); }
    }
});

test('streaming Claude errors retain their HTTP status in the SSE error', async () => {
    const server = await startServer(['test-model'], async function* () {
        yield { type: 'text', text: 'started' };
        throw new ClaudeError('unknown', "API Error: 400 You're out of extra usage.");
    });
    try {
        const response = await fetch(server.baseURL + '/chat/completions', {
            method: 'POST', headers: { authorization: 'Bearer ' + server.token }, body: JSON.stringify({ ...payload, stream: true }),
        });
        const events = (await response.text()).split('\n\n').filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)));
        assert.equal(events.at(-1).error.code, 400);
    } finally {
        await server.close();
    }
});
