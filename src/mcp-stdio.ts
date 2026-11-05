import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const file = process.env.OPENCODE_CLAUDE_MCP_CONFIG;
if (!file) throw new Error('Missing MCP configuration');
const config = JSON.parse(await readFile(file, 'utf8')) as {
    tools: Array<{ name: string; description: string; inputSchema: object }>;
    result?: { name: string; input: unknown; content: string };
};
const server = new McpServer({ name: 'opencode', version: '0.1.0' }, { capabilities: { tools: {} } });
let consumed = false;
server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: config.tools }));
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (consumed || !config.result || request.params.name !== config.result.name ||
        JSON.stringify(request.params.arguments ?? {}) !== JSON.stringify(config.result.input)) {
        throw new Error('No matching external tool result');
    }
    consumed = true;
    return { content: [{ type: 'text', text: config.result.content }] };
});
await server.connect(new StdioServerTransport());
