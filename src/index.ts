import { Model, Plugin, Provider } from '@opencode/plugin';
import { discoverModels } from './agent.js';
import { startServer } from './server.js';
import { filterInstructions } from './instructions.js';

export default Plugin.define({
    id: 'claude-agent-sdk',
    async setup(ctx) {
        const catalog = await discoverModels();
        const server = await startServer(catalog.map((model) => model.id));
        const providerID = Provider.ID.make('claude-agent-sdk');
        try {
            await ctx.session.hook('model.request', (event) => {
                event.headers['x-claude-opencode-session'] = event.sessionID;
                event.headers['x-claude-opencode-agent'] = encodeURIComponent(event.agent);
                event.headers['x-claude-opencode-kind'] = event.kind;
            }, { providerID });
            for (const kind of ['context', 'compaction', 'generate', 'title'] as const) {
                await ctx.session.hook(kind, (event) => filterInstructions(event.system), { providerID });
            }
            await ctx.provider.transform((editor) => {
                editor.add({
                    info: {
                        ...Provider.Info.empty(providerID),
                        name: 'Claude Agent SDK', activation: 'enabled',
                        package: '@opencode/ai/providers/openai-compatible',
                        settings: { baseURL: server.baseURL, apiKey: server.token },
                    },
                    models: catalog.map((entry) => ({
                        ...Model.Info.default(providerID, Model.ID.make(entry.id)),
                        name: entry.name,
                        limit: { context: entry.context, output: 32_000 },
                        capabilities: { tools: true, input: ['text', 'image'], output: ['text'], temperature: false },
                        variants: entry.efforts.map((effort) => ({
                            id: Model.VariantID.make(effort), settings: { reasoningEffort: effort },
                        })),
                    })),
                });
            });
        } catch (error) {
            await server.close();
            throw error;
        }
        return () => server.close();
    },
});
