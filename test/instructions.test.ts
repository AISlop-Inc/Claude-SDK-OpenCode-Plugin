import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterInstructions } from '../src/instructions.js';

test('remove built-in instructions and keep project, agent and developer text', () => {
    const system = [
        { type: 'text', text: 'You are an AI agent running in OpenCode, a coding agent harness. built-in' },
        { type: 'text', text: 'built-in and project', metadata: { experimental: { instructions: [
            { key: 'core/codemode', text: 'codemode' },
            { key: 'core/instructions', text: 'AGENTS.md user instructions' },
            { key: 'core/date', text: 'date' },
            { key: 'plugin/custom', text: 'plugin instruction' },
        ] } } },
        { type: 'text', text: 'agent instruction' },
    ] as Parameters<typeof filterInstructions>[0];
    filterInstructions(system);
    assert.deepEqual(system.map((part) => part.text), ['AGENTS.md user instructions\n\nplugin instruction', 'agent instruction']);
});
