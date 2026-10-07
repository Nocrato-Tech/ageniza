# Conteúdo: a entrevista abre antes do merge de #123 e #128
**Data.** 2026-10-01

**Contexto.** A ordem de módulos decidida em 2026-09-24 é Colaboradores, Clientes, Conteúdo, Tarefas, Financeiro básico, Dashboard. A regra de orquestração exigia #122, #123 e #128 mergeadas antes da entrevista de Conteúdo, e #123 (funções de ciclo de vida do cliente) e #128 (conversa do lado da agência) estavam prontas em branch, esperando revisão. Tarefas foi cogitada para ir antes e descartada: tarefa nasce ligada a conteúdo, e o bloco 0 de Conteúdo já registra "tarefas por conteúdo".

**Decisão.** A **entrevista** de Conteúdo abre agora. A **implementação** de Conteúdo continua dependendo de #122, #123 e #128 mergeadas, porque reaproveita o molde da função de escopo único (#123) e a conversa com `content_id` (#128).

**Consequência.** A entrevista parte dos desenhos já decididos de #123 e #128, não do código mergeado. Se a revisão deles mudar a forma, a SPEC de Conteúdo é ajustada antes do recorte.

**Origem.** Decidido pelo dono do produto em sessão, em 2026-10-01.

