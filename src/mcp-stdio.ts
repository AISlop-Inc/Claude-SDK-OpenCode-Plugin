import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const file = process.env.OPENCODE_CLAUDE_MCP_CONFIG;
if (!file) throw new Error('Missing MCP configuration');
const config = JSON.parse(await readFile(file, 'utf8')) as {
    tools: Array<{ name: string; description: string; inputSchema: object }>;
    results: Array<{ id: string; name: string; content: string }>;
};
const server = new McpServer({ name: 'opencode', version: '0.1.0' }, { capabilities: { tools: {} } });
const consumed = new Set<string>();
server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: config.tools }));
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = config.results.find((result) => result.id === request.params.arguments?.__opencode_result_id && result.name === request.params.name);
    if (!result || consumed.has(result.id)) {
        throw new Error('No matching external tool result');
    }
    consumed.add(result.id);
    return { content: [{ type: 'text', text: result.content }] };
});
await server.connect(new StdioServerTransport());
