# A conversa de um conteúdo fica fora dos contadores do estudo de marca

**Data.** 2026-10-11

**Contexto.** A decisão `2026-10-07-conteudo-conversa-do-conteudo-no-banco.md` fez de `content_id` o terceiro assunto de `client_threads` e deixou para a #261 decidir se as consultas de Clientes que leem `client_threads` sem olhar o assunto contam a conversa de um conteúdo: a contagem "aguardando a agência" do card da carteira, a do resumo do detalhe do cliente e o "com resposta da agência" do Início do portal.

**Decisão.** Esses três contadores contam **só conversa do estudo de marca** (seção ou persona), com `content_id is null`, definido em um lugar (`brandStudyThreadSql`, em `thread-state.ts`) ao lado da definição única de estado da conversa. A conversa de um conteúdo é lida e respondida nas telas de Conteúdo (a última mensagem no detalhe do post, o anel do calendário, a lista "o que precisa de você" do portal), e o selo "N sugestões aguardando" é o sinal de triagem do estudo de marca. Um comentário num post não acende esse selo, não faz o cliente subir na ordem da carteira e não vira "resposta da agência" no Início do portal.

**Consequência.**
- Quando a conversa de conteúdo precisar de um sinal próprio na carteira (por exemplo, "post com comentário esperando a agência"), ele entra como um indicador novo de Conteúdo, com a permissão `conteudo.visualizar`, e não dentro destes contadores.
- As rotas de conversa por id (comentar, resolver) continuam sem tratar o assunto conteúdo; isso é da #259.

**Origem.** Issue #261, pendência registrada no PR #389 (#250).

**Validação.** Pendente de validação do dono.
