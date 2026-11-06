import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { startServer } from '../src/server.js';
import { summarizeMetrics, type TurnMetric } from '../src/metrics.js';

test('subscription lock suppresses auxiliary SDK starts for 60s without extending on blocked requests', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let calls = 0;
    let recovered = false;
    const metrics: TurnMetric[] = [];
    let recorded!: () => void;
    const mock = (({ options }: Parameters<typeof query>[0]) => Object.assign((async function* () {
        calls++;
        if (options!.model === 'limited' && !recovered) {
            yield { type: 'assistant', parent_tool_use_id: null, error: 'rate_limit',
                message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 10:20am (Asia/Tokyo)" }] } } as SDKMessage;
            return;
        }
        yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk-ok',
            usage: { input_tokens: 1, output_tokens: 1 } } as SDKMessage;
    })(), { close() {} })) as typeof query;
    const server = await startServer(['limited', 'other'], undefined, mock, async (metric) => { metrics.push(metric); recorded(); });
    const send = async (model = 'limited', primary = false, hostID = 'ses_core_generate_one') => {
        const finished = new Promise<void>((resolve) => { recorded = resolve; });
        const response = await fetch(server.baseURL + '/chat/completions', {
            method: 'POST', headers: { authorization: 'Bearer ' + server.token, 'x-opencode-session': hostID,
                ...(primary ? { 'x-claude-opencode-session': 'ses_primary', 'x-claude-opencode-agent': 'build',
                    'x-claude-opencode-kind': 'primary' } : {}) },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] }),
        });
        await response.text();
        await finished;
        return response.status;
    };
    try {
        assert.equal(await send(), 400);
        now += 20_000;
        assert.equal(await send(), 400);
        now += 20_000;
        assert.equal(await send('limited', false, 'ses_core_generate_two'), 400);
        assert.equal(calls, 1);
        now += 20_001;
        assert.equal(await send(), 400);
        assert.equal(calls, 2, 'blocked calls must not extend the initial cooldown');
        assert.equal(await send('other'), 200);
        assert.equal(await send('limited', true), 400);
        assert.equal(calls, 4, 'primary explicitly probes the provider even during cooldown');
        assert.equal(await send(), 400);
        assert.equal(calls, 4, 'another model succeeding must not clear this model lock');
        recovered = true;
        assert.equal(await send('limited', true), 200);
        assert.equal(await send(), 200);
        assert.equal(calls, 6, 'primary recovery releases the auxiliary cooldown');
        const blocked = metrics.filter((metric) => metric.reason === 'quota-cooldown');
        assert.equal(blocked.length, 3);
        assert.ok(blocked.every((metric) => metric.sentBytes === 0 && !metric.usage && metric.mode === 'blocked' && metric.sdkStarted === false && metric.errorStatus === 400));
        assert.equal(metrics.filter((metric) => metric.sdkStarted).length, calls);
        assert.match(metrics[0].hostRequest!, /^[a-f0-9]{16}$/);
        assert.equal(metrics[0].hostRequest, metrics[1].hostRequest);
        assert.notEqual(metrics[0].hostRequest, metrics[2].hostRequest);
        assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_PROMPT|ses_core_generate_one/);
        const summary = summarizeMetrics(metrics)[JSON.stringify([metrics[0].build, 'limited', 'unknown'])];
        assert.equal(summary.requests, 6);
        assert.equal(summary.quotaBlocked, 3);
        assert.equal(summary.sdkStarts, 3);
        assert.equal(summary.sdkStartMeasured, 6);
        assert.equal(summary.hostIDsMeasured, 6);
        assert.equal(summary.distinctHostIDs, 2);
        const [legacy] = Object.values(summarizeMetrics([{ ...metrics[0], sdkStarted: undefined, hostRequest: undefined }]));
        assert.equal(legacy.sdkStartMeasured, 0);
    } finally { await server.close(); }
});

test('transient 429 and generic server errors do not activate subscription cooldown', async () => {
    for (const detail of ['API Error: 429 Too many requests', "API Error: 429 You've hit your rate limit", 'API Error: 503 temporarily overloaded']) {
        let calls = 0;
        const mock = (() => Object.assign((async function* () {
            calls++;
            yield { type: 'assistant', parent_tool_use_id: null, error: 'rate_limit',
                message: { content: [{ type: 'text', text: detail }] } } as SDKMessage;
        })(), { close() {} })) as typeof query;
        const server = await startServer(['test'], undefined, mock);
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                const response = await fetch(server.baseURL + '/chat/completions', { method: 'POST',
                    headers: { authorization: 'Bearer ' + server.token },
                    body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'test' }] }) });
                assert.equal(response.status, detail.includes('429') ? 429 : 503);
                await response.text();
            }
            assert.equal(calls, 2);
        } finally { await server.close(); }
    }
});

test('manual bridge trials have a separate metrics lane', async () => {
    const metrics: TurnMetric[] = [];
    let recorded!: () => void;
    const finished = new Promise<void>((resolve) => { recorded = resolve; });
    const mock = (() => Object.assign((async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk-test',
            usage: { input_tokens: 1, output_tokens: 1 } } as SDKMessage;
    })(), { close() {} })) as typeof query;
    const server = await startServer(['test'], undefined, mock, async (metric) => { metrics.push(metric); recorded(); });
    try {
        const response = await fetch(server.baseURL + '/chat/completions', { method: 'POST',
            headers: { authorization: 'Bearer ' + server.token, 'x-claude-opencode-test': 'manual-bridge' },
            body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'trial' }] }) });
        assert.equal(response.status, 200);
        await response.text();
        await finished;
        assert.equal(metrics[0].lane, 'test');
        assert.equal(metrics[0].sdkStarted, true);
    } finally { await server.close(); }
});
