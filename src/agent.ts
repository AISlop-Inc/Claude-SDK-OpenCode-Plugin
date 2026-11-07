import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { conversation, type ChatRequest, type TurnEvent } from './protocol.js';
import { stableJSON, type Checkpoint } from './continuation.js';
import { boundToolResults, toolResultLimit } from './tool-results.js';

export class ClaudeError extends Error {
    readonly status: number;
    readonly quotaLocked: boolean;

    constructor(kind: string, detail: string, statusOverride?: number) {
        super('Claude SDK: ' + kind + (detail ? ': ' + detail : ''));
        const status = Number(detail.match(/API Error: (\d{3})\b/)?.[1]);
        // A subscription quota lock is not a transient upstream failure: OpenCode retries 5xx responses.
        this.quotaLocked = kind === 'rate_limit' &&
            /(?:hit your (?:5-hour|weekly|7-day) limit|hit your .*limit.*\bresets\b|out of extra usage)/i.test(detail);
        this.status = statusOverride ?? (kind === 'authentication_failed' ? 401 : this.quotaLocked ? 400 : status >= 400 && status < 600 ? status : 502);
    }
}

export function sdkOptions(cwd: string): Options {
    return { cwd, tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, verbatimPrompts: true,
        env: { ...process.env, ENABLE_TOOL_SEARCH: 'false',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } };
}

function installedNodes(directory: string): string[] {
    try {
        return readdirSync(directory)
            .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map((version) => join(directory, version, 'bin', 'node'));
    } catch {
        return [];
    }
}

// An app started outside a shell inherits launchd's PATH, which holds no version manager or Homebrew Node.
export function nodeCommand(home = homedir(), path = process.env.PATH ?? ''): string {
    const candidates = [
        fileURLToPath(new URL('../node_modules/.bin/node', import.meta.url)),
        ...path.split(delimiter).filter(Boolean).map((directory) => join(directory, 'node')),
        ...installedNodes(join(home, '.local', 'share', 'mise', 'installs', 'node')),
        ...installedNodes(join(home, '.nvm', 'versions', 'node')),
        '/opt/homebrew/bin/node',
        '/usr/local/bin/node',
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? 'node';
}

export function toolCatalog(request: ChatRequest) {
    const definitions = request.tool_choice === 'none' ? [] : request.tools;
    const names = new Map<string, string>();
    const tools = definitions.map(({ function: definition }) => {
        const alias = 'tool_' + createHash('sha256').update(definition.name).digest('hex').slice(0, 24);
        if ([...names.values()].includes(definition.name)) throw new Error('Duplicate tool: ' + definition.name);
        names.set('mcp__opencode__' + alias, definition.name);
        return { name: alias, description: definition.name + ': ' + (definition.description ?? ''),
            inputSchema: JSON.parse(stableJSON(definition.parameters ?? { type: 'object', properties: {} })) };
    });
    return { names, tools };
}

export async function neverExecute(): Promise<never> {
    throw new Error('Tool execution belongs to OpenCode');
}

export type ManagedTurn = {
    cwd: string;
    sessionID: string;
    resume?: { checkpoint: Checkpoint; kind: 'user' | 'tools'; messages: ChatRequest['messages'] };
    save: (checkpoint: Checkpoint) => void;
    toolResultMaxBytes?: number;
    resultsMeasured?: (result: { offloaded: number; originalBytes: number; deliveredBytes: number; storageErrors: number; retrievals: number; sentBytes: number; limitBytes: number }) => void;
};

export async function* runTurn(request: ChatRequest, signal: AbortSignal, queryFn = query, managed?: ManagedTurn,
    onSDKStart?: () => void): AsyncGenerator<TurnEvent> {
    const transcript = conversation(request);
    const { names, tools } = toolCatalog(request);
    const cwd = managed?.cwd ?? await mkdtemp(join(tmpdir(), 'opencode-claude-'));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const server = new McpServer({ name: 'opencode', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.server.setRequestHandler(CallToolRequestSchema, neverExecute);
    let active: ReturnType<typeof query> | undefined;
    let releasePrompt!: () => void;
    const promptReleased = new Promise<void>((resolve) => { releasePrompt = resolve; });
    try {
        const options = sdkOptions(cwd);
        if (tools.length) {
            let extra: unknown;
            try { extra = JSON.parse(options.env!.CLAUDE_CODE_EXTRA_BODY ?? '{}'); }
            catch { throw new ClaudeError('invalid_configuration', 'CLAUDE_CODE_EXTRA_BODY must be a JSON object', 400); }
            if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
                throw new ClaudeError('invalid_configuration', 'CLAUDE_CODE_EXTRA_BODY must be a JSON object', 400);
            }
            // SDK defer only supports one pending tool; parallel native calls otherwise force a cold rebuild.
            options.env!.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ ...extra,
                tool_choice: { type: 'auto', disable_parallel_tool_use: true } });
        }
        const maxTokens = request.max_completion_tokens ?? request.max_tokens;
        if (maxTokens) options.env!.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
        const effort = request.reasoning_effort;
        const priorCalls = managed?.resume?.kind === 'tools' ? managed.resume.checkpoint.assistant.tool_calls ?? [] : [];
        const delivered = managed?.resume?.kind === 'tools'
            ? await boundToolResults(managed.resume.messages, cwd,
                [...names.values()].includes('read') ? managed.toolResultMaxBytes ?? toolResultLimit() : 0) : undefined;
        const retrievals = priorCalls.filter((call) => {
            if (call.function.name !== 'read') return false;
            const args = JSON.parse(call.function.arguments);
            const path = args?.path ?? args?.filePath;
            return typeof path === 'string' && /^tool-result-[a-f0-9]{64}\.txt$/.test(path.slice(cwd.length + 1)) && path.startsWith(cwd + '/');
        }).length;
        if (delivered) managed?.resultsMeasured?.({ ...delivered, retrievals,
            sentBytes: Buffer.byteLength(JSON.stringify(delivered.messages.map((message) => message.content))) });
        const configPath = join(cwd, 'mcp-config.json');
        if (managed) await writeFile(configPath, JSON.stringify({ tools, results: priorCalls.map((call) => ({
            id: call.id,
            name: [...names.entries()].find(([, original]) => original === call.function.name)?.[0].replace(/^mcp__opencode__/, ''),
            content: delivered!.messages.find((message) => message.tool_call_id === call.id)!.content,
        })) }), { mode: 0o600 });
        onSDKStart?.();
        active = queryFn({
            prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
                if (managed?.resume?.kind === 'tools') { await promptReleased; return; }
                const content = managed?.resume ? conversation({ ...request, messages: managed.resume.messages }).content : transcript.content;
                yield { type: 'user', message: { role: 'user', content: content as SDKUserMessage['message']['content'] }, parent_tool_use_id: null };
            })(),
            options: { ...options, model: request.model, systemPrompt: transcript.system,
                ...(managed ? { persistSession: true, ...(managed.resume ? { resume: managed.resume.checkpoint.sdkSessionID } : {}),
                    env: { ...options.env, OPENCODE_CLAUDE_MCP_CONFIG: configPath } } : {}),
                abortController: controller, includePartialMessages: true, maxTurns: 1,
                effort: effort === 'none' ? undefined : effort === 'minimal' ? 'low' : effort,
                ...(effort === 'none' ? { thinking: { type: 'disabled' as const } } : {}),
                mcpServers: tools.length ? { opencode: managed
                    ? { type: 'stdio', command: nodeCommand(), args: [fileURLToPath(new URL('./mcp-stdio.js', import.meta.url))] }
                    : { type: 'sdk', name: 'opencode', instance: server } } : {},
                hooks: { PreToolUse: [{ hooks: [async (input) => {
                    const call = input.hook_event_name === 'PreToolUse' ? priorCalls.find((call) => call.id === input.tool_use_id &&
                        names.get(input.tool_name) === call.function.name) : undefined;
                    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: call ? 'allow' : 'defer',
                        ...(call ? { updatedInput: { __opencode_result_id: call.id } } : {}) } };
                }] }] },
            },
        });
        let streamedText = false;
        let calls = 0;
        let stopReason: string | null = null;
        let text = '';
        const toolCalls: NonNullable<ChatRequest['messages'][number]['tool_calls']> = [];
        for await (const message of active) {
            if (managed && tools.length && message.type === 'system' && message.subtype === 'init' &&
                !message.mcp_servers.some((server) => server.name === 'opencode' && server.status === 'connected')) {
                throw new ClaudeError('mcp_unavailable', 'OpenCode tools could not connect. Ensure Node.js is available in PATH.', 400);
            }
            if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
                const event = message.event;
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    streamedText = true;
                    text += event.delta.text;
                    yield { type: 'text', text: event.delta.text };
                }
            } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
                if (message.error) {
                    const detail = message.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
                    throw new ClaudeError(message.error, detail);
                }
                stopReason = message.message.stop_reason;
                for (const block of message.message.content) {
                    if (block.type === 'text' && !streamedText) { text += block.text; yield { type: 'text', text: block.text }; }
                    if (block.type !== 'tool_use') continue;
                    const name = names.get(block.name) ?? [...names.values()].find((name) => name === block.name);
                    if (!name) throw new Error('Claude requested an unavailable tool: ' + block.name);
                    const call = { id: block.id, type: 'function' as const, function: { name, arguments: JSON.stringify(block.input) } };
                    toolCalls.push(call);
                    yield { type: 'tool', call: { index: calls++, ...call } };
                }
                streamedText = false;
            } else if (message.type === 'result') {
                const deferred = calls > 0 && message.subtype === 'success' && !message.api_error_status &&
                    message.terminal_reason !== 'tool_deferred_unavailable' &&
                    (message.stop_reason === 'tool_deferred' || message.terminal_reason === 'tool_deferred');
                if (message.is_error && !deferred && !(calls > 0 && message.subtype === 'error_max_turns')) {
                    const status = 'api_error_status' in message && typeof message.api_error_status === 'number' ? message.api_error_status : undefined;
                    throw new ClaudeError(message.subtype, (status ? 'API Error: ' + status + ' ' : '') +
                        (message.subtype === 'success' ? message.result : message.errors.join('; ')));
                }
                const usage = message.usage;
                if (managed && message.session_id && message.subtype === 'success' && (!message.is_error || deferred) &&
                    ((!calls && stopReason !== 'max_tokens') || (deferred && toolCalls.some((call) => call.id === message.deferred_tool_use?.id)))) {
                    managed.save({ sessionID: managed.sessionID, sdkSessionID: message.session_id, request,
                        assistant: { role: 'assistant', content: text || null, ...(calls ? { tool_calls: toolCalls } : {}) } });
                }
                const cached = usage.cache_read_input_tokens ?? 0;
                const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + cached;
                yield { type: 'done', reason: calls ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'stop',
                    usage: { prompt_tokens: input, completion_tokens: usage.output_tokens,
                        total_tokens: input + usage.output_tokens, prompt_tokens_details: { cached_tokens: cached,
                            cache_write_tokens: usage.cache_creation_input_tokens ?? 0 } } };
                return;
            }
        }
        throw new Error('Claude SDK ended without a result');
    } finally {
        signal.removeEventListener('abort', abort);
        releasePrompt();
        active?.close();
        await server.close();
        if (!managed) await rm(cwd, { recursive: true, force: true });
    }
}

export async function discoverModels() {
    const cwd = await mkdtemp(join(tmpdir(), 'opencode-claude-models-'));
    async function control<T>(options: Options, use: (active: ReturnType<typeof query>) => Promise<T>) {
        let stop!: () => void;
        const stopped = new Promise<void>((resolve) => { stop = resolve; });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const active = query({ prompt: (async function* () { await stopped; })(), options: { ...options, abortController: controller } });
        try {
            return await use(active);
        } finally {
            clearTimeout(timer);
            stop();
            active.close();
        }
    }
    try {
        const available = await control(sdkOptions(cwd), (active) => active.supportedModels());
        const models = [];
        const seen = new Set<string>();
        for (const model of available) {
            const id = model.resolvedModel;
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const usage = await control({ ...sdkOptions(cwd), model: id }, (active) => active.getContextUsage({ detail: 'summary' }));
            if (!(usage.maxTokens > 0)) throw new Error('Invalid context limit for ' + id);
            models.push({ id, name: id.replace(/^claude-/, 'Claude '), context: usage.maxTokens,
                efforts: model.supportedEffortLevels ?? [] });
        }
        if (!models.length) throw new Error('Claude SDK returned no resolved models. Check Claude Code authentication.');
        return models;
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
}
