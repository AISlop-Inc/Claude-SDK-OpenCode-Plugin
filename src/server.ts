import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { requestSchema, type ChatRequest, type TurnEvent, type ToolCall } from './protocol.js';
import { ClaudeError, runTurn } from './agent.js';

export type RunTurn = (request: ChatRequest, signal: AbortSignal) => AsyncIterable<TurnEvent>;

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

export async function startServer(modelIDs: string[], run: RunTurn = runTurn) {
    const token = randomUUID();
    const controllers = new Set<AbortController>();
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
            for await (const event of run(payload, controller.signal)) {
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
        },
    };
}
