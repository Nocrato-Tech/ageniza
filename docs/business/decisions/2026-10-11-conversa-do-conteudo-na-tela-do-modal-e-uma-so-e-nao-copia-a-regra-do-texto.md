# A conversa do conteúdo no modal: a lista e o modal do estudo de marca, uma conversa só e a regra do texto vinda do contrato

**Data.** 2026-10-11

**Contexto.** A #266 pede a conversa do conteúdo no fim da aba Geral do modal, "no formato da conversa do estudo de marca" (`specs/conteudo.md` seção 7). A API já aceita o conteúdo como assunto, com uma conversa por conteúdo e `409 CONTENT_NOT_OPEN` para a agência em produção ou cancelado ([`2026-10-11-conversa-do-conteudo-nas-rotas-de-conversa-do-cliente.md`](2026-10-11-conversa-do-conteudo-nas-rotas-de-conversa-do-cliente.md), #259). O componente de conversa de Clientes (`conversation.tsx`) nasceu para vários assuntos por tela e tinha a própria cópia da regra do texto. O que a SPEC e a #259 não fecham, e alguém tentaria de novo:

**Decisão.**

1. **Mesmo componente, mesmo formato.** O modal usa o `Conversation` do estudo de marca, que passa a aceitar o assunto `{ contentId }`: lista de conversas, abrir a conversa num modal sobre o modal do conteúdo, responder, resolver. Não há segundo componente.
2. **Uma conversa só, sem segundo "Nova conversa".** Como abrir a conversa de um conteúdo que já tem uma escreve nela, a tela só oferece "Nova conversa" enquanto a lista, já lida, está vazia. Durante a leitura da lista e depois que a conversa existe, quem escreve responde dentro dela.
3. **A tela não copia a regra do texto: pergunta ao contrato.** A validação do que se digita usa `CommentBodySchema`, o mesmo schema da API, e a tela só traduz a recusa (vazio, mais de 5.000 bytes, caractere que não é aceito). A cópia antiga (`hasForbiddenControlCharacters` mais o limite de bytes) deixava passar bidi, CGJ e o espaço Braille até a API responder `400`. Vale também para a tela do estudo de marca e do portal, que usam o mesmo componente.
4. **O motivo de não comentar vem antes do `409`, e o `409` continua valendo.** Com o conteúdo em produção ou cancelado, quem pode escrever (`conteudo.operar`) vê o motivo no lugar do campo de resposta e do botão de nova conversa, e continua lendo e resolvendo. Quem só lê não vê o motivo, vê "Esta conversa é somente leitura". O estado que a tela conhece pode estar velho (outra pessoa mandou o conteúdo de volta para produção): o `409 CONTENT_NOT_OPEN` da API é mostrado com texto próprio da tela, mantém o digitado e faz o calendário atrás reler.
5. **A permissão e o cliente arquivado.** Escrever é `conteudo.operar` (a leitura do conteúdo já vem de quem abriu o modal); cliente arquivado deixa a conversa só leitura, inclusive sem Resolver. A tela esconde, a API decide (`403`, `409 CLIENT_ARCHIVED`).
6. **A conversa fica fora do `<form>` do modal.** O campo de resposta é um formulário; dentro do formulário do conteúdo, o envio de uma resposta também submeteria e fecharia o conteúdo.

**Consequência.**

- Nenhuma tabela, rota ou permissão nova: só tela. `ThreadSubject` continua no estudo de marca; o componente passa a usar `ConversationSubject`.
- O modal sobre o modal tem título próprio ("Conversa sobre ..."), para não haver dois diálogos com o mesmo nome; Esc fecha só o de cima.
- Depois de escrever, o calendário relê (o card mostra a última mensagem e a contagem).
- Se o dono quiser mostrar a conversa direto na aba, sem abrir um modal, é troca de apresentação no componente; as regras acima não mudam.

**Origem.** Issue #266; #259 (rotas); decisão do dono de 2026-10-01 (conversa do conteúdo no formato do estudo de marca); item 64 do `docs/implementation-checklist.md` (texto livre tem uma regra só).

**Validação.** Pendente de validação do dono.
