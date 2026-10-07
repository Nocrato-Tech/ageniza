# As abas Performance e Entregas ficam desabilitadas, com o motivo, até o Conteúdo
**Data.** 2026-10-07

**Contexto.** A #110 perguntava o que as abas `Performance` e `Entregas` do modal de colaborador mostram. Não há o que contar: entregas e pendências pressupõem tarefas atribuídas a pessoas, e nem Conteúdo nem Tarefas foram implementados. Qualquer métrica definida agora seria inventada.

**Decisão.** As duas abas ficam como estão no MVP: **visíveis, desabilitadas e com o motivo à vista**, que é o que a tela já faz (`specs/colaboradores.md`, seção 7). O conteúdo delas depende do módulo Conteúdo (entregas e subtarefas). Quando o Conteúdo existir, uma issue nova define as métricas a partir dos dados reais.

**Consequência.** Nenhuma rota, coluna ou tela nova. O modal não é redesenhado quando o conteúdo chegar, porque a estrutura de abas já existe. A linha "Conteúdo das abas Performance e Entregas" da seção 10 de `specs/colaboradores.md` segue listada, mas o gatilho passa a ser a issue aberta quando o Conteúdo existir, e não "a primeira entrevista que criar tarefa atribuível a colaborador"; a SPEC não foi reescrita neste PR, e esta entrada prevalece sobre ela.

**Origem.** Decisão do maestro, com autonomia dada pelo dono em 2026-10-07, registrada no fechamento da issue #110. **Pendente de validação** pelo dono do produto.

