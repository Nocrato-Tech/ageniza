# O cliente pede ajuste depois de aprovar, até a véspera da publicação

**Data.** 2026-11-13

**Contexto.** Hoje só um conteúdo **aguardando aprovação** aceita o pedido de ajuste do cliente. O cliente que aprovou e depois percebe um erro na legenda ou na capa só consegue "Desfazer aprovação" (que devolve o conteúdo a aguardando) e, depois, pedir o ajuste: dois passos para dizer uma coisa. O quadro do redesenho mostra "Pedir ajuste" também no post aprovado.

**Decisão.**

1. **O cliente pode pedir ajuste num conteúdo já aprovado até a publicação, menos no próprio dia da publicação.** O dia é o de `publishOn`, no fuso de São Paulo: a véspera, às 23h59, ainda aceita; a partir da meia-noite do dia planejado, não. Um conteúdo aprovado cujo dia planejado é hoje ou já passou não aceita o pedido.
2. **O efeito é o do pedido de hoje.** O conteúdo passa a **em ajuste** e o comentário do cliente, obrigatório, entra na conversa do conteúdo. A data, a hora, a legenda, o título e a revisão não mudam.
3. **O que já era recusado continua sendo.** Em produção, já em ajuste, publicado e cancelado não aceitam o pedido; o conteúdo aguardando aprovação o aceita em qualquer data, como hoje.
4. **A aprovação cai.** Pendente de validação do dono: ao entrar em "em ajuste" vindo de aprovado, o conteúdo perde quem aprovou e quando (e o motivo, quando foi a agência que aprovou em nome do cliente), como já acontece ao voltar a aguardando aprovação. O recado que o cliente deixou ao aprovar continua na conversa, como comentário dele.
5. **O link do e-mail segue a mesma regra.** Pendente de validação do dono: a pessoa que entra pelo link de aprovação pede ajuste de um aprovado do lote até a véspera da publicação, pelo mesmo critério do portal.
6. **A hora de publicação não conta.** Pendente de validação do dono: só o dia decide. No dia planejado, mesmo que a hora marcada ainda não tenha chegado, o pedido é recusado; na véspera, mesmo às 23h59, é aceito.
7. **A recusa diz até quando vale.** Pendente de validação do dono: a resposta continua sendo o conflito `CONTENT_NOT_AWAITING_APPROVAL`, e a mensagem passa a ser "Este conteúdo não aceita mais pedido de ajuste: ele vale até a véspera da publicação."

**Consequência.**

- Não é estrutural: nenhuma tabela, coluna, policy ou permissão existente muda, e a forma de nenhuma resposta muda. A migration cria uma função auxiliar fechada a todos (o `revoke` que o gate de decisões estruturais acusa é só esse fechamento, sem nada já implantado), troca o corpo das duas funções que recebem o pedido (a do portal e a do link) para que perguntem a regra a essa função, e acrescenta a transição `aprovado → em ajuste` ao guarda dos conteúdos.
- A regra mora numa função só do banco, lida da linha já travada e do relógio de quando ela foi travada: uma publicação, uma edição de data ou um pedido concorrente que chegou antes é visto, e o pedido que esperou o dia virar é julgado pelo dia novo.
- A tela do portal mostra "Pedir ajuste" no post aprovado cuja data de publicação é depois de hoje e trata o `409` da recusa; a agência passa a ver um conteúdo aprovado voltar a "em ajuste", com a notificação de sempre ao responsável. Os fluxos mobile do portal e da agência descrevem isso.

**Origem.** Decisão do dono do produto em 2026-11-13: "o cliente pode pedir ajuste num conteúdo já aprovado até a publicação, menos no próprio dia da publicação".

**Validação.** Validada pelo dono em 2026-11-13.
