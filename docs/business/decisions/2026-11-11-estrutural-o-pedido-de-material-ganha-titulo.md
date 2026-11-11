# ESTRUTURAL: o pedido de material ganha um título, e o prazo ganha estado

**Data.** 2026-11-11

**Contexto.** O pedido de material é um assunto da conversa do cliente, com texto e **prazo opcional** ([`2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente`](2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente.md)). O quadro do redesenho (r0) mostra cada pedido com **título**, descrição ("citação"), "Aberta por Marina Bastos (agência)", "Entregar até 10/11 · atrasado" e as etiquetas aberta, aguardando você e resolvida, na Visão geral do cliente e em "A agência pediu" no portal.

**Decisão.**

1. **Título.** Todo pedido novo tem **título** (obrigatório, até 80 caracteres), além da descrição (o texto de hoje). O pedido que já existe fica sem título, e a tela usa o começo da descrição.
2. **Prazo.** O prazo opcional já existe (de hoje a 90 dias, dia de São Paulo) e **não muda de tipo**. Ele ganha estado: "atrasado" quando o dia passou e o pedido não foi resolvido.
3. **Etiquetas, derivadas da conversa.** Na agência: **aberta** (a agência pediu e o cliente ainda não respondeu), **aguardando você** (o último comentário é do cliente) e **resolvida**. No portal: o pedido aparece enquanto aberto, com o título, a descrição e "até <data>".
4. **Quem abriu.** "Aberta por <nome> (agência)" usa quem abriu a conversa, que já é guardado; no portal, só "A agência pediu", sem o nome de quem abriu.
5. **Ações no portal.** "Responder" (comentário), "Enviar fotos" e "Gravar depoimento" ([`2026-11-11-estrutural-o-cliente-envia-material-pelo-portal`](2026-11-11-estrutural-o-cliente-envia-material-pelo-portal.md)) e "Ver o pedido" (a página "Pedidos da agência"). A agência continua sendo a única que abre e resolve.

**Substitui.** O item 1 de [`2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente`](2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente.md) no que diz que o pedido é "com prazo opcional" e mais nada: passa a exigir título. Ela segue valendo no resto (assunto próprio, só a agência abre, o cliente responde, o portal não vê a conversa de conteúdo em produção).

**Consequência.**

- **É estrutural:** altera uma tabela que já existe (`client_threads` ganha o título, anulável no banco e obrigatório na API para pedido novo) e muda o contrato de pedido que o portal e o mobile leem. **Migration** nova, grant por coluna, **sem backfill**. A RLS não muda.
- **Risco: Alto** (portal e conversa do cliente, que a RLS do portal lê). Pede revisão de segurança independente: o título não aparece em outro assunto, o portal não abre pedido, e o nome de quem abriu não chega ao portal.
- O fluxo mobile da agência e o do portal descrevem o título e o estado do prazo.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro de dar título ao pedido.

**Validação.** Pendente de validação do dono.
