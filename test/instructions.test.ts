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
    assert.deepEqual((system[0].metadata as { experimental: { instructions: { key: string }[] } }).experimental.instructions.map((source) => source.key),
        ['core/instructions', 'plugin/custom']);
});

test('remove untagged core identity and task/worktree instructions without removing explicit user sources', () => {
    const identity = '# Your Model\n- Name: Claude Opus\n- Provider ID: claude-agent-sdk\n- Model ID: claude-opus-5-5';
    const task = 'Persistent tasks are separate interactive sessions, not subagents. Use task tools.\nThis is a persistent child task of ses_parent.';
    const system = [
        { type: 'text', text: identity },
        { type: 'text', text: task },
        { type: 'text', text: 'When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider session_move.' },
        { type: 'text', text: 'project', metadata: { experimental: { instructions: [
            { key: 'core/instructions', text: identity },
            { key: 'api/runtime-rule', text: 'Keep the user runtime rule' },
            { key: 'core/skill-guidance', text: 'builtin skills catalog' },
        ] } } },
        { type: 'text', text: 'My custom agent mentions # Your Model but is not the builtin identity.' },
    ] as Parameters<typeof filterInstructions>[0];
    filterInstructions(system);
    assert.deepEqual(system.map((part) => part.text), [identity + '\n\nKeep the user runtime rule',
        'My custom agent mentions # Your Model but is not the builtin identity.']);
});

test('empty builtin source blocks are removed and malformed plugin metadata is retained safely', () => {
    const system = [
        { type: 'text', text: 'builtin only', metadata: { experimental: { instructions: [{ key: 'core/date', text: 'date' }] } } },
        { type: 'text', text: 'plugin text', metadata: { experimental: { instructions: { custom: true } } } },
        { type: 'text', text: 'another plugin text', metadata: { experimental: { instructions: [null] } } },
    ] as unknown as Parameters<typeof filterInstructions>[0];
    filterInstructions(system);
    assert.deepEqual(system.map((part) => part.text), ['plugin text', 'another plugin text']);
});

test('an explicitly configured agent prompt is preserved even when it starts like a builtin', () => {
    const custom = 'Persistent tasks are separate interactive sessions, not subagents. My explicit agent role.';
    const system = [
        { type: 'text', text: custom },
        { type: 'text', text: 'Persistent tasks are separate interactive sessions, not subagents. Builtin guidance.' },
    ] as Parameters<typeof filterInstructions>[0];
    filterInstructions(system, custom);
    assert.deepEqual(system.map((part) => part.text), [custom]);
});
