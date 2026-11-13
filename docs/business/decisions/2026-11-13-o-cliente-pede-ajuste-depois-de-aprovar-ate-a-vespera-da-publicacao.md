# O cliente pede ajuste depois de aprovar, até a véspera da publicação

**Data.** 2026-11-13

**Contexto.** Hoje só um conteúdo **aguardando aprovação** aceita o pedido de ajuste do cliente. O cliente que aprovou e depois percebe um erro na legenda ou na capa só consegue "Desfazer aprovação" (que devolve o conteúdo a aguardando) e, depois, pedir o ajuste: dois passos para dizer uma coisa. O quadro do redesenho mostra "Pedir ajuste" também no post aprovado.

**Decisão.**

1. **O cliente pode pedir ajuste num conteúdo já aprovado até a publicação, menos no próprio dia da publicação.** O dia é o de `publishOn`, no fuso de São Paulo: a véspera, às 23h59, ainda aceita; a partir da meia-noite do dia planejado, não. Um conteúdo aprovado cujo dia planejado é hoje ou já passou não aceita o pedido.
2. **O efeito é o do pedido de hoje.** O conteúdo passa a **em ajuste** e o comentário do cliente, obrigatório, entra na conversa do conteúdo. A data, a hora, a legenda, o título e a revisão não mudam.
3. **O que já era recusado continua sendo.** Em produção, já em ajuste, publicado e cancelado não aceitam o pedido; o conteúdo aguardando aprovação o aceita em qualquer data, como hoje.
4. **A aprovação cai.** Pendente de validação do dono: ao entrar em "em ajuste" vindo de aprovado, o conteúdo perde quem aprovou e quando (e o motivo, quando foi a agência que aprovou em nome do cliente), como já acontece ao voltar a aguardando aprovação. O recado que o cliente deixou ao aprovar continua na conversa, como comentário dele.
5. **O link do e-mail não muda: só decide o que aguarda aprovação.** A regra nova vale para a pessoa do portal, com conta. O link de aprovação continua pedindo ajuste só de um conteúdo aguardando aprovação, em qualquer data; um aprovado, por qualquer pessoa ou pela agência, responde `409` `CONTENT_NOT_AWAITING_APPROVAL`, com a mensagem de antes ("Só um conteúdo aguardando aprovação recebe um pedido de ajuste."), sem falar de véspera. Isso segue três decisões já validadas pelo dono: [o e-mail de aprovação leva um link que aprova sem login](2026-10-26-estrutural-o-e-mail-de-aprovacao-leva-um-link-que-aprova-sem-login.md), item 4 (o link só decide conteúdo que aguarda aprovação); [a sessão de duas horas e o que a página lê](2026-10-27-o-link-de-aprovacao-sessao-de-duas-horas-limites-e-o-que-a-pagina-le.md), item 6 (fora de aguardando aprovação, `409`); e [o cliente pode desfazer a aprovação antes da publicação](2026-11-06-cliente-pode-desfazer-aprovacao-antes-da-publicacao.md) (links sem conta não ganham essa ação). Pedir ajuste num aprovado faz o que desfazer a aprovação faz.
6. **A hora de publicação não conta.** Pendente de validação do dono: só o dia decide. No dia planejado, mesmo que a hora marcada ainda não tenha chegado, o pedido é recusado; na véspera, mesmo às 23h59, é aceito.
7. **A recusa diz até quando vale.** Pendente de validação do dono: no portal, a resposta continua sendo o conflito `CONTENT_NOT_AWAITING_APPROVAL`, e a mensagem passa a ser "Este conteúdo não aceita mais pedido de ajuste: ele vale até a véspera da publicação." (o link do e-mail mantém a mensagem que tinha, item 5).

**Consequência.**

- Não é estrutural: nenhuma tabela, coluna, policy ou permissão existente muda, e a forma de nenhuma resposta muda. A migration cria uma função auxiliar fechada a todos (o `revoke` que o gate de decisões estruturais acusa é só esse fechamento, sem nada já implantado), troca o corpo da função do portal que recebe o pedido para que pergunte a regra a essa função (a do link do e-mail não muda), e acrescenta a transição `aprovado → em ajuste` ao guarda dos conteúdos.
- A regra mora numa função só do banco, lida da linha já travada e do relógio de quando ela foi travada: uma publicação, uma edição de data ou um pedido concorrente que chegou antes é visto, e o pedido que esperou o dia virar é julgado pelo dia novo.
- A tela do portal mostra "Pedir ajuste" no post aprovado cuja data de publicação é depois de hoje e trata o `409` da recusa; a agência passa a ver um conteúdo aprovado voltar a "em ajuste", com a notificação de sempre ao responsável. Os fluxos mobile do portal e da agência descrevem isso.

**Origem.** Decisão do dono do produto em 2026-11-13: "o cliente pode pedir ajuste num conteúdo já aprovado até a publicação, menos no próprio dia da publicação". A regra central (itens 1 a 3) veio do dono nesse dia; os detalhes escolhidos pelo implementador (itens 4 a 7) aguardam validação.

**Validação.** Pendente de validação do dono.
