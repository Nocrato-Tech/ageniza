# Um PR por escopo, com revisão por subtarefa

**Data.** 2026-11-06

**Contexto.** O fluxo anterior era de vários PRs pequenos: API e tela separadas, migration em PR próprio e teto de ~800 linhas de diff (decisão `2026-10-07-pr-agrupado-por-tema`). Cada PR custava CI, revisão, rodadas e ordem de merge, e a entrega ficou lenta. O dono decidiu em 2026-11-06 trocar o fluxo.

**Decisão.**

1. O trabalho é planejado por **escopo**: um módulo, um épico ou um pedido do dono. O planejador divide o escopo em subtarefas pequenas, cada uma com os arquivos que pode tocar e o contrato entre elas, e o dono aprova o plano antes de qualquer execução.
2. Os implementadores executam as subtarefas em ondas paralelas, cada um no seu worktree e numa branch local a partir da branch de integração do escopo (`feat/<escopo>`).
3. Cada subtarefa é revisada antes de entrar na integração: nível Baixo pelo maestro, que lê o diff; Médio pelo revisor de código; Alto pela revisão de segurança de `docs/security-review.md`. O revisor é de modelo diferente do implementador. Um achado volta ao mesmo implementador e o mesmo revisor confere a correção, num laço até zerar os achados.
4. As subtarefas aprovadas se juntam na branch de integração, e o escopo sobe num **único PR** para `develop`, mesmo grande: um escopo inteiro pode subir num PR só. O PR leva uma linha `Closes #N` por issue, a tabela aceite → teste → mutação e as revisões das subtarefas publicadas nele. Esse comentário é o registro da revisão de segurança que o `AGENTS.md` exige.
5. API, tela e migration continuam sendo subtarefas separadas, revisadas separadamente, mas vão no mesmo PR. A migration é subtarefa própria, revisada no nível Alto, e entra na integração antes da subtarefa da API que a usa.
6. O dono testa o PR localmente antes do merge.

**Consequência.** Substitui a decisão `2026-10-07-pr-agrupado-por-tema`: o teto de ~800 linhas, API e tela em PRs separados e migration em PR próprio deixam de valer. A re-revisão deixa de ser só para achado Alto: dentro do laço da subtarefa, o mesmo revisor confere toda correção até não sobrar achado. O CI roda uma vez por escopo, não uma vez por subtarefa. A migration continua sendo a única mudança que não se desfaz, por isso a sua revisão é sempre de nível Alto.

**Origem.** Decidido pelo dono do produto em sessão, em 2026-11-06.

**Validação.** Validada pelo dono em 2026-11-06.
