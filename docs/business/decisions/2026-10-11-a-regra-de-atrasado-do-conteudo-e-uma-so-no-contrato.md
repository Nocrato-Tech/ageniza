# A regra de "atrasado" e de "prazo em dois dias" do conteúdo é uma só, no contrato, e o SQL da carteira é escrito a partir dela

**Data.** 2026-10-11

**Contexto.** A decisão `2026-10-11-indicadores-de-conteudo-da-carteira-e-ordem-por-atraso` deixou a regra de atraso escrita no SQL da carteira (módulo `clients`) e avisou que, quando o módulo de Conteúdo a expusesse, a definição devia ser unificada. As telas de Conteúdo a leem no navegador (`deadlineAlert`, em `apps/web/src/content-labels.ts`), a partir do dia planejado e do dia de hoje em São Paulo: eram duas escritas da mesma regra, e nada as prendia uma à outra. A issue é a #549, aviso do Cardume no PR #548.

**Decisão.**
1. **A definição mora em `packages/contracts`** (`content-deadline.ts`): os estados que contam (`CONTENT_DEADLINE_OPEN_STATUSES`: em produção, aguardando aprovação, em ajuste e aprovado), a janela (`CONTENT_DUE_SOON_DAYS`, 2) e a função `contentDeadline(conteúdo, hoje)`, que responde `overdue` para o dia planejado anterior a hoje e `due-soon` de hoje a dois dias à frente, os dois extremos dentro, e nada para publicado e cancelado. As regras de negócio não mudam: é a de 2026-10-11 de #261, com o texto da SPEC (`specs/conteudo.md` seção 4).
2. **O SQL é escrito a partir dela:** `contentDeadlineSql`, em `apps/api/src/modules/contents/deadline-sql.ts`, monta o filtro de estados, o de atrasado e o de prazo curto com as constantes do contrato, e a carteira os usa (`clients/service.ts`). Nenhum estado nem número de dias fica escrito à mão no SQL.
3. **Uma função SQL em `app_private` foi descartada:** a tela não chama o banco para decidir um selo, e uma função SQL pediria migration e deixaria a tela com a sua própria cópia. O contrato é o único lugar que as duas pontas (SQL do servidor e navegador) podem importar.
4. **Um teste de paridade prende o SQL à função:** semeia um conteúdo de cada estado em cada dia ao redor de hoje e confere que a contagem da carteira é a que `contentDeadline` diz de cada um, e os números por extenso (8 atrasados, 12 com prazo curto).

**Consequência.**
- Mudar um estado ou a janela é mexer no contrato, e fica vermelho no teste do contrato e nos da carteira; mudar só uma das duas escritas (a comparação do SQL ou a da função) fica vermelho na paridade.
- A tela passa a usar `contentDeadline` num PR de tela à parte (a #549 pede as duas pontas; API e tela vão em PRs separados).
- Não há migration, tabela, coluna ou grant.

**Origem.** Issue #549, aviso do Cardume no PR #548 (#261).

**Validação.** Pendente de validação do dono.
