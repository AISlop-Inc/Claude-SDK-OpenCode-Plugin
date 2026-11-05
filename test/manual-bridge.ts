import assert from 'node:assert/strict';
import { startServer } from '../dist/server.js';

const model = process.env.CLAUDE_SMOKE_MODEL;
if (!model) throw new Error('Set CLAUDE_SMOKE_MODEL to a resolved Claude model ID');
const server = await startServer([model]);
try {
    const messages: object[] = [{ role: 'user', content: 'Reference: ' + 'alpha beta gamma delta epsilon zeta eta theta. '.repeat(500) + '\nCall the echo tool once with text SDK_OK. After receiving its result, reply with that result only.' }];
    const tools = [{ type: 'function', function: { name: 'echo', description: 'Returns the supplied text.',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }];
    async function send() {
        const response = await fetch(server.baseURL + '/chat/completions', {
            method: 'POST', headers: { authorization: 'Bearer ' + server.token, 'content-type': 'application/json',
                ...(process.env.NO_RESUME ? {} : { 'x-claude-opencode-session': 'ses_manual_test',
                    'x-claude-opencode-agent': 'test', 'x-claude-opencode-kind': 'primary' }) },
            body: JSON.stringify({ model, messages, tools, max_tokens: process.env.FORCE_FALLBACK && messages.length > 1 ? 1023 : 1024, reasoning_effort: 'low' }),
            signal: AbortSignal.timeout(90_000),
        });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        return body;
    }
    const first = await send();
    assert.equal(first.choices[0].finish_reason, 'tool_calls');
    const assistant = first.choices[0].message;
    const call = assistant.tool_calls[0];
    assert.equal(call.function.name, 'echo');
    const args = JSON.parse(call.function.arguments);
    assert.equal(args.text, 'SDK_OK');
    messages.push(assistant, { role: 'tool', tool_call_id: call.id, content: args.text });
    const second = await send();
    console.log(JSON.stringify({ first: first.usage, second: second.usage }));
    assert.equal(second.choices[0].finish_reason, 'stop');
    assert.match(second.choices[0].message.content, /SDK_OK/);
    console.log('PASS: live SDK → HTTP tool call → client tool result → final response');
} finally {
    await server.close();
}
