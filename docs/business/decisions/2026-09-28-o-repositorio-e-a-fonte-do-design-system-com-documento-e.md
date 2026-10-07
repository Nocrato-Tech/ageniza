# O repositório é a fonte do design system, com documento e página viva

**Data.** 2026-09-28

**Contexto.** A entrada anterior deixou pendente a fundação do design system no código, que precisa existir antes da primeira task de tela. O design system estava especificado numa página do Notion, ["UI System — Figma, Design Tokens & CSS"](https://app.notion.com/p/3d886d2ba8b08172a3fbcc31e1548c31), e o `AGENTS.md` trata o Notion como insumo histórico, nunca como fonte de verdade: a tela seria obrigada a seguir um documento que o próprio repositório não reconhece. No código havia 20 linhas de CSS com as cores escritas direto e um `Button` com `tone`, onde a página definia `variant`.

**Decisão.** O design system **sai do Notion e passa a viver no repositório**, que vira a fonte de verdade dele. Ele tem duas formas:

- um **documento**, [`docs/design-system.md`](../../design-system.md), com o conteúdo migrado da página e adaptado aos caminhos e à stack reais;
- uma **página no próprio app** que mostra os tokens e os componentes ao vivo.

A entrega sai em duas partes: a **parte A** traz o documento, os tokens em CSS em `apps/web/src/styles/` e o `Button` de `packages/ui` no vocabulário do documento (`variant`, `size`, `loading`); a **parte B** traz a página viva.

**Consequência.** O `AGENTS.md`, o `CONTRIBUTING.md` e o `module-process.md` passam a apontar o design system para o documento, e a página do Notion vira registro histórico. Os valores vivem nos arquivos de CSS: em divergência entre o documento e o CSS, vale o CSS.

**Os cinco pontos abaixo, deixados em aberto quando esta entrada foi escrita, foram decididos pelo dono do produto ainda em 2026-09-28**, na revisão do PR #157 (parte A):

1. **Confirmado: o repositório é a fonte do design system.** A página do Notion vira registro histórico, nunca mais referência de trabalho — como a "Decisão" acima já registrava, e agora sem ponto em aberto associado.
2. **A Definition of Done de UI (seção 23 do documento) passa a ser critério de aceite de toda task `escopo:web`**, não mais proposta — **sem** o item de paridade com o Figma, removido em vez de reescrito para "quando houver Figma": na sequência esboço → código → refino (entrada anterior), o Figma só entra no refino, depois que a tela já está no ar, então não é critério de aceite da implementação inicial. Seção 23 do documento reescrita de acordo.
3. **Os valores de token propostos na parte A foram aprovados, depois de corrigir os pares que falhavam WCAG AA.** As quatro falhas listadas na seção 20.1 (`text/muted` sobre `bg/hover` nos dois temas e sobre `bg/elevated` no Dark; `text/link` e `text/danger` no Dark sobre `bg/canvas`/`bg/surface`) foram corrigidas ajustando a luminosidade de `color/slate/500` e `color/slate/400` e introduzindo dois primitives-irmãos só de texto (`color/indigo/400` para `text/link` no Dark, `color/red/400` novo para `text/danger` no Dark), sem mudar a matiz de nenhum token nem o valor de `action/primary/bg` ou `action/danger/bg`. A tabela final, com as razões de contraste recalculadas, está na seção 20.1 do documento; `text/link` e `text/danger` ficam restritos a `bg/canvas`/`bg/surface` (não passam sobre `bg/elevated`/`bg/hover` no Dark), registrado no documento em vez de deixados falhando.
4. **A parte A basta para tirar as 27 tasks de tela do Bloqueio `decisão`.** Não espera a parte B: a página viva é conveniência de consulta, não pré-requisito de implementação. A saída do Bloqueio passa a ser automática quando o PR que traz a parte A é mergeado em `develop` — refletido no bullet de Bloqueio da entrada anterior.
5. **A parte B adota shadcn/ui**, copiado para o repositório como base de mecânica e acessibilidade, com as variáveis do shadcn (`--primary`, `--muted-foreground`, `--ring` etc.) como ponte para os tokens Ageniza, como a seção 15 do documento já descrevia. Não fica com mecânica própria.

**Origem.** Decidido pelo dono do produto em sessão, em 2026-09-28, ao aprovar as recomendações apresentadas na revisão dos PRs.

