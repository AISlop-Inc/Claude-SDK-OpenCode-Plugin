import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { runTurn } from '../src/agent.js';
import { requestSchema } from '../src/protocol.js';
import { continuation, type Checkpoint } from '../src/continuation.js';

test('real SDK completes tool-result and multiple-user continuations without waiting for input closure', { timeout: 30_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'claude-native-continuation-'));
    const bodies: string[] = [];
    let stage = 'setup';
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        if (request.method !== 'POST' || request.url?.split('?')[0] !== '/v1/messages') {
            response.writeHead(404).end();
            return;
        }
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        const body = JSON.parse(bodies.at(-1)!);
        const hasResult = body.messages?.some((message: { content?: unknown }) => Array.isArray(message.content) &&
            message.content.some((block: { type?: string }) => block.type === 'tool_result'));
        const tool = !hasResult && body.tools?.find((entry: { name?: string }) => entry.name?.startsWith('mcp__opencode__'));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [
            { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
                content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: tool
                ? { type: 'tool_use', id: 'toolu_fixture', name: tool.name, input: {} } : { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: tool
                ? { type: 'input_json_delta', partial_json: '{"path":"fixture.txt"}' } : { type: 'text_delta', text: 'SDK_FIXTURE_OK' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
        ];
        for (const event of events) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
        response.end();
    });
    try {
        await mkdir(join(cwd, 'home'));
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const baseURL = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        const isolated = ((input: Parameters<typeof query>[0]) => {
            // Only OS/runtime essentials and our isolation settings reach the fixture child. No real credentials or cloud routes.
            const allowed = new Set(['PATH', 'USER', 'LOGNAME', 'SystemRoot', 'TMPDIR', 'LANG', 'LC_ALL',
                'ENABLE_TOOL_SEARCH', 'OPENCODE_CLAUDE_MCP_CONFIG']);
            const env = Object.fromEntries(Object.entries(input.options?.env ?? {}).filter(([key]) => allowed.has(key)));
            const mcp = input.options?.mcpServers?.opencode;
            return query({ ...input, options: { ...input.options, cwd,
                ...(mcp?.type === 'stdio' ? { mcpServers: { opencode: { ...mcp,
                    args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/mcp-stdio.ts', import.meta.url))] } } } : {}),
                env: { ...env, HOME: join(cwd, 'home'), CLAUDE_CONFIG_DIR: join(cwd, 'config'),
                    ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'loopback-fixture-not-a-real-key',
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
                    CLAUDE_CODE_MAX_RETRIES: '0' } } });
        }) as typeof query;
        const payload = requestSchema.parse({ model: 'claude-haiku-5-5', reasoning_effort: 'none', max_tokens: 64,
            messages: [{ role: 'user', content: 'Reply with the fixture response.' }] });
        stage = 'text';
        const events = await Array.fromAsync(runTurn(payload, AbortSignal.timeout(20_000), isolated));
        assert.equal(bodies.length, 1, 'normal fixture completion should issue exactly one Messages POST');
        assert.ok(events.some((event) => event.type === 'text' && event.text === 'SDK_FIXTURE_OK'));
        assert.equal(events.at(-1)?.type, 'done');
        const withTools = requestSchema.parse({ ...payload, tools: [{ type: 'function', function: {
            name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        } }] });
        let checkpoint: Checkpoint | undefined;
        stage = 'defer';
        const toolEvents = await Array.fromAsync(runTurn(withTools, AbortSignal.timeout(20_000), isolated,
            { cwd, sessionID: 'ses_fixture', save(value) { checkpoint = value; } }));
        assert.equal(bodies.length, 2);
        assert.ok(toolEvents.some((event) => event.type === 'tool' && event.call.function.name === 'read'));
        assert.ok(toolEvents.some((event) => event.type === 'done' && event.reason === 'tool_calls'));
        assert.ok(checkpoint, 'a deferred native tool turn must save a usable checkpoint');
        const result = { role: 'tool' as const, tool_call_id: 'toolu_fixture', content: 'FULL_TOOL_RESULT_FIXTURE' };
        const continued = { ...withTools, messages: [...withTools.messages, checkpoint.assistant, result] };
        let completed: Checkpoint | undefined;
        stage = 'resume';
        const resumed = await Array.fromAsync(runTurn(continued, AbortSignal.timeout(20_000), isolated,
            { cwd, sessionID: 'ses_fixture', resume: { checkpoint, kind: 'tools', messages: [result] }, save(value) { completed = value; } }));
        assert.equal(bodies.length, 3, 'bootstrap, one tool turn and its resume should each issue one Messages POST');
        assert.match(bodies[2], /FULL_TOOL_RESULT_FIXTURE/);
        assert.ok(resumed.some((event) => event.type === 'done' && event.reason === 'stop'));
        assert.ok(completed);
        const followUp = { ...continued, messages: [...continued.messages, completed.assistant,
            { role: 'user' as const, content: 'USER_FOLLOWUP_FIXTURE' }, { role: 'user' as const, content: 'USER_STEERING_FIXTURE' }] };
        const append = continuation(completed, 'ses_fixture', followUp);
        assert.ok(append);
        stage = 'user-resume';
        await Array.fromAsync(runTurn(followUp, AbortSignal.timeout(20_000), isolated,
            { cwd, sessionID: 'ses_fixture', resume: { checkpoint: completed, ...append }, save() {} }));
        assert.equal(bodies.length, 4);
        assert.match(bodies[3], /USER_FOLLOWUP_FIXTURE/);
        assert.match(bodies[3], /USER_STEERING_FIXTURE/);
    } catch (error) {
        console.error(JSON.stringify({ fixtureStage: stage, messagesPosts: bodies.length }));
        throw error;
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(cwd, { recursive: true, force: true });
    }
});
