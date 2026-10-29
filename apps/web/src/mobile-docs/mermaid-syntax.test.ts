// @vitest-environment jsdom
import mermaid from 'mermaid';
import { describe, expect, it } from 'vitest';

import { guide } from './content.js';

const FENCE = '```';
const blocks = guide.flatMap((page) =>
  [...page.source.matchAll(new RegExp(`${FENCE}mermaid\\n([\\s\\S]*?)\\n${FENCE}`, 'g'))].map((match) => ({ file: page.file, source: match[1]! }))
);

// A diagram that GitHub and mermaid cannot read would reach the team as an empty box, so every block is parsed by the real library.
describe('the mermaid blocks of docs/mobile', { timeout: 60_000 }, () => {
  it('has the diagrams the flows need', () => {
    const kinds = blocks.map((block) => block.source.split('\n')[0]);
    expect(kinds.filter((kind) => kind === 'stateDiagram-v2')).toHaveLength(5);
    expect(kinds.filter((kind) => kind === 'sequenceDiagram')).toHaveLength(4);
  });

  it.each(blocks.map((block, index) => [`${block.file} #${index + 1}`, block.source] as const))('%s parses', async (_name, source) => {
    await expect(mermaid.parse(source)).resolves.toBeTruthy();
  });

  it('rejects a block with a mistake, so the check above can fail', async () => {
    await expect(mermaid.parse('stateDiagram-v2\n    a --> --> b')).rejects.toThrow();
  });
});
