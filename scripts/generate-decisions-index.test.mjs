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

  it('não move decisão pelo título: a seção que o índice dá é a que vale', () => {
    const readme = `${README_INTRO}\n## Autorização e transversais\n\n- 2026-09-16 — [m](m.md)\n- 2026-10-07 — [g](g.md)\n\n## Conteúdo\n\n- 2026-10-01 — [c](c.md)\n`;
    const { text, warnings } = buildIndex({
      files: {
        'c.md': decision('Conteúdo: pastas de mídia', '2026-10-01'),
        'm.md': decision('Mídia vai direto do navegador', '2026-09-16'),
        'g.md': decision('`ageniza_app` não tem DELETE', '2026-10-07'),
      },
      readme,
    });

    expect(text).toContain(
      '## Autorização e transversais\n\n- 2026-09-16 — [Mídia vai direto do navegador](m.md)\n- 2026-10-07 — [`ageniza_app` não tem DELETE](g.md)\n',
    );
    expect(text).toContain('## Conteúdo\n\n- 2026-10-01 — [Conteúdo: pastas de mídia](c.md)\n');
    expect(text).toContain('## Mídia\n\n_Nenhuma decisão._\n');
    expect(text).toContain('## Infra\n\n_Nenhuma decisão._\n');
    expect(warnings).toEqual([]);
  });

  it('avisa seção do índice que não está em MODULES e manda suas decisões para "A classificar"', () => {
    const readme = `${README_INTRO}\n## Módulo novo\n\n- 2026-01-01 — [n](n.md)\n`;
    const { text, warnings } = buildIndex({
      files: { 'n.md': decision('N', '2026-01-01') },
      readme,
    });

    expect(text).toContain('## A classificar\n\n- 2026-01-01 — [N](n.md)\n');
    expect(warnings).toContain('seção "Módulo novo" não está em MODULES: as decisões dela vão para "A classificar"');
  });

  it('normaliza CRLF do índice: a saída tem só LF, inclusive na introdução', () => {
    const readme = `# Índice\r\n\r\nTexto de apoio.\r\n\r\n## Infra\r\n\r\n- 2026-01-01 — [a](a.md)\r\n`;
    const { text } = buildIndex({
      files: { 'a.md': decision('A', '2026-01-01') },
      readme,
    });

    expect(text).not.toContain('\r');
    expect(text.startsWith('# Índice\n\nTexto de apoio.\n')).toBe(true);
    expect(text).toContain('## Infra\n\n- 2026-01-01 — [A](a.md)\n');
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
