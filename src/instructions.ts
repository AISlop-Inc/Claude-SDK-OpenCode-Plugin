import type { SystemPart } from '@opencode/ai/effect';

export function filterInstructions(system: SystemPart[]) {
    for (let index = system.length - 1; index >= 0; index--) {
        const part = system[index];
        if (part.type !== 'text') continue;
        const metadata = part.metadata as { experimental?: { instructions?: { key: string; text: string }[] } } | undefined;
        const sources = metadata?.experimental?.instructions;
        if (sources) {
            const kept = sources.filter((source) => !source.key.startsWith('core/') || source.key === 'core/instructions');
            system[index] = { ...part, text: kept.map((source) => source.text).join('\n\n') };
        } else if (part.text.startsWith('You are an AI agent running in OpenCode, a coding agent harness.')) {
            system.splice(index, 1);
        }
    }
}
