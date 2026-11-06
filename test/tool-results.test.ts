import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundToolResults, toolResultLimit } from '../src/tool-results.js';
import { measurePayload, summarizePayloads, type TurnMetric } from '../src/metrics.js';
import { requestSchema } from '../src/protocol.js';
import { runTurn } from '../src/agent.js';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

test('large new results have bounded UTF-8 previews and exact private full outputs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'claude-result-test-'));
    const content = 'OPENING_CONTEXT\n' + '日本語🙂\n'.repeat(2000) + 'FINAL_STATUS_OK';
    const original = [{ role: 'tool' as const, tool_call_id: 'call-a', content }];
    try {
        const result = await boundToolResults(original, cwd, 1024);
        assert.equal(result.offloaded, 1);
        assert.equal(result.storageErrors, 0);
        assert.equal(result.originalBytes, Buffer.byteLength(content));
        assert.ok(result.deliveredBytes <= 1024);
        const preview = result.messages[0].content as string;
        assert.doesNotMatch(preview, /�/);
        assert.match(preview, /Use read with offset\/limit/);
        assert.ok(preview.startsWith('OPENING_CONTEXT\n'));
        assert.ok(preview.endsWith('FINAL_STATUS_OK'));
        const [file] = await readdir(cwd);
        assert.match(file, /^tool-result-[a-f0-9]{64}\.txt$/);
        assert.equal(await readFile(join(cwd, file), 'utf8'), content);
        assert.equal((await stat(join(cwd, file))).mode & 0o777, 0o600);
        assert.ok(preview.includes(JSON.stringify(join(cwd, file))));
        assert.equal(original[0].content, content);
        const again = await boundToolResults([{ ...original[0], tool_call_id: 'call-b' }], cwd, 1024);
        assert.equal(again.offloaded, 1);
        assert.equal((await readdir(cwd)).length, 1);
    } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('small, disabled, non-tool and non-string results are unchanged; storage failure keeps full text', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'claude-result-test-'));
    const large = { role: 'tool' as const, tool_call_id: 'a', content: 'x'.repeat(5000) };
    try {
        const messages = [{ role: 'user' as const, content: 'x'.repeat(5000) },
            { role: 'tool' as const, tool_call_id: 'a', content: 'small' },
            { role: 'tool' as const, tool_call_id: 'b', content: [{ type: 'text' as const, text: 'x'.repeat(5000) }] }];
        assert.deepEqual((await boundToolResults(messages, cwd, 1024)).messages, messages);
        assert.deepEqual((await boundToolResults([large], cwd, 0)).messages, [large]);
        assert.deepEqual(await readdir(cwd), []);
        const failed = await boundToolResults([large], join(cwd, 'missing'), 1024);
        assert.deepEqual(failed.messages, [large]);
        assert.equal(failed.offloaded, 0);
        assert.equal(failed.storageErrors, 1);
        assert.equal(failed.deliveredBytes, failed.originalBytes);
    } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('result budget is explicit, disableable and validated', () => {
    const previous = process.env.OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES;
    try {
        delete process.env.OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES;
        assert.equal(toolResultLimit(), 16384);
        assert.equal(toolResultLimit(0), 0);
        assert.equal(toolResultLimit(2048), 2048);
        for (const value of [null, {}, true, -1, 1.5, Infinity]) assert.throws(() => toolResultLimit(value), /must be/);
        for (const value of ['0', '1024', '32768']) {
            process.env.OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES = value;
            assert.equal(toolResultLimit(), Number(value));
        }
        for (const value of ['-1', '10', 'NaN', '1.5', '']) {
            process.env.OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES = value;
            assert.throws(toolResultLimit, /must be/);
        }
    } finally {
        if (previous === undefined) delete process.env.OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES;
        else process.env.OPENCODE_CLAUDE_TOOL_RESULT_MAX_BYTES = previous;
    }
});

test('payload metrics store sizes and hashes only and do not count inherited results as new', () => {
    const request = requestSchema.parse({ model: 'test', messages: [
        { role: 'system', content: 'PRIVATE_SYSTEM' },
        { role: 'tool', tool_call_id: 'old', content: 'PRIVATE_OLD_RESULT' },
        { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'new', content: 'PRIVATE_NEW_RESULT🙂' },
    ], tools: [{ type: 'function', function: { name: 'read', description: 'PRIVATE_DEFINITION' } }] });
    const sizes = measurePayload(request);
    assert.equal(sizes.newToolResults.length, 1);
    assert.equal(sizes.newToolResults[0].tool, 'read');
    assert.equal(sizes.newToolResults[0].bytes, Buffer.byteLength('PRIVATE_NEW_RESULT🙂'));
    assert.match(sizes.system.hash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(sizes), /PRIVATE_/);
    const metric: TurnMetric = { at: '2026-11-07T00:00:00Z', build: 'a', session: 's', model: 'test', lane: 'primary',
        mode: 'resume-tools', reason: 'exact-continuation', outcome: 'complete', durationMs: 1, messageCount: 4,
        toolCount: 1, sentBytes: 1, payload: sizes };
    const summary = summarizePayloads([metric, { ...metric, payload: undefined },
        { ...metric, mode: 'bootstrap', reason: 'model-changed' }, { ...metric, outcome: 'error' }]);
    assert.equal(summary.sameModelContinuations, 2);
    assert.equal(summary.payloadMeasured, 1);
    assert.equal(summary.missingPayload, 1);
    assert.equal(summary.newToolResults.read.count, 1);
    assert.equal(summary.distinctSystemHashes, 1);
    assert.equal(summary.deliveryMeasured, 0);
    assert.equal(summarizePayloads([]).systemBytes, null);
    const unusual = summarizePayloads([{ ...metric, payload: { ...sizes,
        newToolResults: [{ ...sizes.newToolResults[0], tool: '__proto__' }] } }]);
    assert.equal(unusual.newToolResults.__proto__.count, 1);
});

test('offline replay keeps observed new results separate from inherited hypothetical results', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'claude-replay-test-'));
    const archive = join(cwd, 'archive.jsonl');
    const content = 'PRIVATE_ARCHIVE_CONTENT\n'.repeat(1500);
    await writeFile(archive, [
        { type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: JSON.stringify({
            role: 'tool', tool_call_id: 'old', content: [{ type: 'text', text: content }],
        }) }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: 'small' }] } },
    ].map((record) => JSON.stringify(record)).join('\n'));
    try {
        const { stdout } = await promisify(execFile)(process.execPath,
            ['--import', 'tsx', 'scripts/replay-tool-results.ts', archive, join(cwd, 'results')]);
        const output = JSON.parse(stdout);
        assert.equal(output.summaries[0].sample, 'observed-new-results');
        assert.equal(output.summaries[0].count, 1);
        assert.equal(output.summaries[0].avoidedInlineBytes, 0);
        assert.equal(output.summaries[1].sample, 'inherited-results-hypothetical-first-insertion');
        assert.equal(output.summaries[1].count, 1);
        assert.equal(output.summaries[1].offloaded, 1);
        assert.ok(output.summaries[1].avoidedInlineBytes > 0);
        assert.doesNotMatch(stdout, /PRIVATE_ARCHIVE_CONTENT/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a continuation without read capability, or with budget disabled, receives the complete result', async () => {
    for (const [tool, budget] of [['echo', 1024], ['read', 0]] as const) {
        const cwd = await mkdtemp(join(tmpdir(), 'claude-capability-test-'));
        const content = 'KEEP_FULL_RESULT'.repeat(3000);
        const request = requestSchema.parse({ model: 'test', messages: [{ role: 'user', content: 'hello' }],
            tools: [{ type: 'function', function: { name: tool } }] });
        const assistant = { role: 'assistant' as const, tool_calls: [{ id: 'call', type: 'function' as const,
            function: { name: tool, arguments: '{}' } }] };
        const result = { role: 'tool' as const, tool_call_id: 'call', content };
        const mock = (({ options }: Parameters<typeof query>[0]) => Object.assign((async function* () {
            const config = JSON.parse(await readFile(options!.env!.OPENCODE_CLAUDE_MCP_CONFIG!, 'utf8'));
            assert.equal(config.results[0].content, content);
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk',
                usage: { input_tokens: 1, output_tokens: 1 } } as SDKMessage;
        })(), { close() {} })) as typeof query;
        try {
            await Array.fromAsync(runTurn({ ...request, messages: [...request.messages, assistant, result] },
                new AbortController().signal, mock, { cwd, sessionID: 'ses', toolResultMaxBytes: budget,
                    resume: { kind: 'tools', messages: [result], checkpoint: { sessionID: 'ses', sdkSessionID: 'sdk', request, assistant } },
                    save() {},
                }));
            assert.deepEqual(await readdir(cwd), ['mcp-config.json']);
        } finally { await rm(cwd, { recursive: true, force: true }); }
    }
});
