import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { conversation, requestSchema, type ChatRequest, type TurnEvent, type ToolCall } from './protocol.js';
import { ClaudeError, runTurn } from './agent.js';
import { continuation, rebuildReason, requestIdentity, SessionQueue, type Checkpoint, type RequestIdentity } from './continuation.js';
import { buildFingerprint, measurePayload, recordMetric, type TurnMetric } from './metrics.js';
import { toolResultLimit } from './tool-results.js';

export type RunTurn = (request: ChatRequest, signal: AbortSignal, identity?: RequestIdentity, hostRequest?: string, testRun?: boolean) => AsyncIterable<TurnEvent>;

async function readRequest(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new Error('Request exceeds 32 MiB');
        chunks.push(chunk);
    }
    return requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
}

export async function startServer(modelIDs: string[], run?: RunTurn, queryFn: typeof query = query,
    metricSink: (metric: TurnMetric) => Promise<void> = queryFn === query ? recordMetric : async () => {},
    toolResultMaxBytes = toolResultLimit()) {
    const token = randomUUID();
    const controllers = new Set<AbortController>();
    const queue = new SessionQueue();
    const sessions = new Map<string, { cwd: string; checkpoint: Checkpoint }>();
    const quotaLocks = new Map<string, { until: number; error: ClaudeError }>();
    const build = await buildFingerprint();
    async function* managedRun(payload: ChatRequest, signal: AbortSignal, identity?: RequestIdentity, hostRequest?: string, testRun = false): AsyncGenerator<TurnEvent> {
        const started = Date.now();
        const sizes = measurePayload(payload);
        const metric: TurnMetric = { at: new Date().toISOString(), build,
            session: identity ? createHash('sha256').update(identity.sessionID).digest('hex').slice(0, 16) : null,
            model: payload.model, lane: testRun ? 'test' : identity?.kind ?? 'unknown', mode: 'bootstrap', reason: 'no-checkpoint',
            durationMs: 0, messageCount: payload.messages.length, toolCount: payload.tools.length,
            sentBytes: sizes.history.bytes, outcome: 'error', payload: sizes, sdkStarted: false,
            ...(hostRequest ? { hostRequest } : {}) };
        try {
            for await (const event of execute()) {
                if (event.type === 'done') {
                    metric.outcome = 'complete';
                    metric.usage = event.usage;
                    quotaLocks.delete(payload.model);
                }
                yield event;
            }
        } catch (error) {
            if (error instanceof ClaudeError) metric.errorStatus = error.status;
            if (error instanceof ClaudeError && error.quotaLocked && metric.mode !== 'blocked') {
                quotaLocks.set(payload.model, { until: Date.now() + 60_000, error });
            }
            throw error;
        } finally {
            metric.durationMs = Date.now() - started;
            if (signal.aborted && metric.outcome !== 'complete') metric.outcome = 'cancelled';
            try { await metricSink(metric); } catch { console.error('Claude feedback: unable to save turn metrics'); }
        }
        async function* execute(): AsyncGenerator<TurnEvent> {
        if (!identity || identity.kind !== 'primary') {
            const lock = quotaLocks.get(payload.model);
            if (lock && lock.until > Date.now()) {
                metric.mode = 'blocked';
                metric.reason = 'quota-cooldown';
                metric.sentBytes = 0;
                throw lock.error;
            }
            quotaLocks.delete(payload.model);
            metric.reason = identity ? 'auxiliary-lane' : 'missing-identity';
            yield* runTurn(payload, signal, queryFn, undefined, () => { metric.sdkStarted = true; });
            return;
        }
        const key = JSON.stringify([identity.sessionID, identity.agent]);
        const previous = sessions.get(key);
        sessions.delete(key);
        const result = previous && continuation(previous.checkpoint, identity.sessionID, payload);
        if (previous && !result) metric.reason = rebuildReason(previous.checkpoint, payload);
        if (previous && !result) await rm(previous.cwd, { recursive: true, force: true });
        if (!result && sessions.size >= 64) {
            // Evict an inactive checkpoint rather than permanently disabling continuity at capacity.
            const oldest = sessions.entries().next().value!;
            sessions.delete(oldest[0]);
            await rm(oldest[1].cwd, { recursive: true, force: true });
            metric.reason = 'capacity-eviction';
        }
        if (result) {
            metric.mode = 'resume-' + result.kind;
            metric.reason = 'exact-continuation';
            metric.sentBytes = Buffer.byteLength(JSON.stringify(result.kind === 'tools' ? result.messages.map((message) => message.content) :
                conversation({ ...payload, messages: result.messages }).content));
        }
        const cwd = result && previous ? previous.cwd : await mkdtemp(join(tmpdir(), 'opencode-claude-session-'));
        let saved = false;
        try {
            yield* runTurn(payload, signal, queryFn, { cwd, sessionID: identity.sessionID, toolResultMaxBytes,
                ...(result && previous ? { resume: { checkpoint: previous.checkpoint, ...result } } : {}),
                resultsMeasured(result) {
                    const { offloaded, originalBytes, deliveredBytes, storageErrors, retrievals, limitBytes } = result;
                    metric.toolResults = { offloaded, originalBytes, deliveredBytes, storageErrors, retrievals, limitBytes };
                    metric.sentBytes = result.sentBytes;
                },
                save(checkpoint) {
                    if (signal.aborted) return;
                    sessions.set(key, { cwd, checkpoint });
                    saved = true;
                },
            }, () => { metric.sdkStarted = true; });
        } finally {
            if (!saved) await rm(cwd, { recursive: true, force: true });
        }
        }
    }
    const server = createServer((request, response) => {
        void handle(request, response).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (response.destroyed) return;
            if (!response.headersSent) json(response, error instanceof ClaudeError ? error.status : 502, { error: { message, type: 'upstream_error' } });
            else response.end('data: ' + JSON.stringify({ error: { message, type: 'upstream_error',
                ...(error instanceof ClaudeError ? { code: error.status } : {}) } }) + '\n\n');
        });
    });

    async function handle(request: IncomingMessage, response: ServerResponse) {
        if (request.headers.authorization !== 'Bearer ' + token) {
            json(response, 401, { error: { message: 'Unauthorized' } });
            return;
        }
        if (request.method === 'GET' && request.url === '/v1/models') {
            json(response, 200, { object: 'list', data: modelIDs.map((id) => ({ id, object: 'model', owned_by: 'claude-agent-sdk' })) });
            return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
            json(response, 404, { error: { message: 'Not found' } });
            return;
        }
        let payload: ChatRequest;
        try {
            payload = await readRequest(request);
            if (!modelIDs.includes(payload.model)) throw new Error('Unknown model: ' + payload.model);
        } catch (error) {
            json(response, 400, { error: { message: error instanceof Error ? error.message : String(error), type: 'invalid_request_error' } });
            return;
        }
        const controller = new AbortController();
        controllers.add(controller);
        const abort = () => controller.abort();
        response.once('close', abort);
        const id = 'chatcmpl-' + randomUUID();
        const created = Math.floor(Date.now() / 1000);
        let text = '';
        const calls: ToolCall[] = [];
        let done = false;
        async function chunk(delta: object, finish: string | null = null, usage?: unknown) {
            if (!response.headersSent) response.writeHead(200, {
                'content-type': 'text/event-stream', 'cache-control': 'no-cache',
            });
            const body = { id, object: 'chat.completion.chunk', created, model: payload.model,
                choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
            if (!response.write('data: ' + JSON.stringify(body) + '\n\n')) {
                await once(response, 'drain', { signal: controller.signal });
            }
        }
        try {
            const identity = requestIdentity(request.headers);
            const hostID = request.headers['x-opencode-session'];
            const hostRequest = typeof hostID === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(hostID)
                ? createHash('sha256').update(hostID).digest('hex').slice(0, 16) : undefined;
            const testRun = request.headers['x-claude-opencode-test'] === 'manual-bridge';
            for await (const event of queue.run(identity, controller.signal, () => (run ?? managedRun)(payload, controller.signal, identity, hostRequest, testRun))) {
                if (controller.signal.aborted) break;
                if (event.type === 'text') {
                    text += event.text;
                    if (payload.stream) await chunk({ role: 'assistant', content: event.text });
                } else if (event.type === 'tool') {
                    calls.push(event.call);
                    if (payload.stream) await chunk({ role: 'assistant', tool_calls: [event.call] });
                } else {
                    done = true;
                    if (payload.stream) {
                        await chunk({}, event.reason, event.usage);
                        response.end('data: [DONE]\n\n');
                    } else {
                        json(response, 200, { id, object: 'chat.completion', created, model: payload.model,
                            choices: [{ index: 0, message: { role: 'assistant', content: text || null,
                                ...(calls.length ? { tool_calls: calls.map(({ index, ...call }) => call) } : {}) },
                            finish_reason: event.reason }], usage: event.usage });
                    }
                    break;
                }
            }
            if (!done && !controller.signal.aborted) throw new Error('Claude turn ended without completion');
        } finally {
            response.off('close', abort);
            controllers.delete(controller);
        }
    }

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    return {
        baseURL: `http://127.0.0.1:${address.port}/v1`, token,
        async close() {
            for (const controller of controllers) controller.abort();
            const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            server.closeAllConnections();
            await closed;
            await Promise.all([...sessions.values()].map(({ cwd }) => rm(cwd, { recursive: true, force: true })));
            sessions.clear();
        },
    };
}
