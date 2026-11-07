import type { SystemPart } from '@opencode/ai/effect';

const builtinPrefixes = [
    'You are an AI agent running in OpenCode, a coding agent harness.',
    'Persistent tasks are separate interactive sessions, not subagents.',
    'When you create a worktree outside the current working directory and intend to use it as your primary working directory,',
];

export function filterInstructions(system: SystemPart[], agentInstruction?: string) {
    for (let index = system.length - 1; index >= 0; index--) {
        const part = system[index];
        if (part.type !== 'text') continue;
        if (agentInstruction && part.text === agentInstruction) continue;
        const metadata = part.metadata as { experimental?: { instructions?: { key: string; text: string }[] } } | undefined;
        const sources = metadata?.experimental?.instructions;
        if (Array.isArray(sources) && sources.every((source) => typeof source?.key === 'string' && typeof source?.text === 'string')) {
            const kept = sources.filter((source) => !source.key.startsWith('core/') || source.key === 'core/instructions');
            if (!kept.length) { system.splice(index, 1); continue; }
            system[index] = { ...part, text: kept.map((source) => source.text).join('\n\n'),
                metadata: { ...part.metadata, experimental: { ...metadata!.experimental, instructions: kept } } };
        } else if (builtinPrefixes.some((prefix) => part.text.startsWith(prefix)) ||
            /^# Your Model\r?\n- Name: [^\r\n]+\r?\n- Provider ID: [^\r\n]+\r?\n- Model ID: [^\r\n]+\s*$/.test(part.text)) {
            system.splice(index, 1);
        }
    }
}
