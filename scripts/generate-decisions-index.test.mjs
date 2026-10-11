import { describe, expect, it } from 'vitest';

import { buildIndex } from './generate-decisions-index.mjs';

const decision = (title, date) => `# ${title}\n\n**Data.** ${date}\n\nCorpo.\n`;
const README_INTRO = '# Índice\n\nTexto de apoio.\n';

describe('buildIndex', () => {
  it('lista cada decisão no módulo do índice, com título e data lidos do arquivo', () => {
    const readme = `${README_INTRO}\n## Infra\n\n- 2026-01-01 — [Antigo](a.md)\n`;
    const { text } = buildIndex({
      files: { 'a.md': decision('Título novo', '2026-02-02') },
      readme,
    });

    expect(text).toContain('## Infra\n\n- 2026-02-02 — [Título novo](a.md)\n');
    expect(text).not.toContain('Antigo');
    expect(text.startsWith(README_INTRO)).toBe(true);
  });

  it('põe decisão sem linha no índice em "A classificar" e avisa', () => {
    const { text, warnings } = buildIndex({
      files: { 'b.md': decision('Nova sem módulo', '2026-03-03') },
      readme: `${README_INTRO}\n## Infra\n\n`,
    });

    expect(text).toContain('## A classificar\n\n- 2026-03-03 — [Nova sem módulo](b.md)\n');
    expect(warnings).toContain('b.md não tem módulo no índice: vai para "A classificar"');
  });

  it('tira do índice a linha de um arquivo apagado e avisa', () => {
    const { text, warnings } = buildIndex({
      files: {},
      readme: `${README_INTRO}\n## Infra\n\n- 2026-01-01 — [Sumiu](sumiu.md)\n`,
    });

    expect(text).not.toContain('sumiu.md');
    expect(warnings).toContain('índice cita sumiu.md, que não existe na pasta: linha removida');
  });

  it('recusa decisão sem título ou sem data', () => {
    expect(() => buildIndex({ files: { 'c.md': '**Data.** 2026-01-01\n' }, readme: README_INTRO }))
      .toThrow('c.md: falta a linha "# " ou "**Data.**"');
    expect(() => buildIndex({ files: { 'd.md': '# Sem data\n' }, readme: README_INTRO }))
      .toThrow('d.md: falta a linha "# " ou "**Data.**"');
  });

  it('recusa a mesma decisão em dois módulos', () => {
    const readme = `${README_INTRO}\n## Infra\n\n- 2026-01-01 — [e](e.md)\n\n## Clientes\n\n- 2026-01-01 — [e](e.md)\n`;
    expect(() => buildIndex({ files: { 'e.md': decision('E', '2026-01-01') }, readme }))
      .toThrow('e.md aparece em "Clientes" e em "Infra"');
  });

  it('move decisão de banco de "Autorização e transversais" para "Infra" pelo título', () => {
    const readme = `${README_INTRO}\n## Autorização e transversais\n\n- 2026-10-07 — [g](g.md)\n`;
    const { text } = buildIndex({
      files: { 'g.md': decision('`ageniza_app` não tem DELETE', '2026-10-07') },
      readme,
    });

    expect(text).toMatch(/## Infra\n\n- 2026-10-07 — \[`ageniza_app` não tem DELETE\]\(g\.md\)/);
    expect(text).toMatch(/## Autorização e transversais\n\n_Nenhuma decisão\._/);
  });

  it('move decisão de mídia de "Autorização e transversais" para "Mídia", e não mexe em Conteúdo', () => {
    const readme = `${README_INTRO}\n## Conteúdo\n\n- 2026-10-01 — [c](c.md)\n\n## Autorização e transversais\n\n- 2026-09-16 — [m](m.md)\n`;
    const { text } = buildIndex({
      files: {
        'c.md': decision('Conteúdo: pastas de mídia', '2026-10-01'),
        'm.md': decision('Mídia vai direto do navegador', '2026-09-16'),
      },
      readme,
    });

    expect(text).toContain('## Mídia\n\n- 2026-09-16 — [Mídia vai direto do navegador](m.md)\n');
    expect(text).toContain('## Conteúdo\n\n- 2026-10-01 — [Conteúdo: pastas de mídia](c.md)\n');
  });

  it('ordena por data dentro de cada módulo', () => {
    const readme = `${README_INTRO}\n## Infra\n\n- 2026-05-05 — [b](b.md)\n- 2026-01-01 — [a](a.md)\n`;
    const { text } = buildIndex({
      files: { 'a.md': decision('A', '2026-01-01'), 'b.md': decision('B', '2026-05-05') },
      readme,
    });

    expect(text.indexOf('[A]')).toBeLessThan(text.indexOf('[B]'));
  });
});
