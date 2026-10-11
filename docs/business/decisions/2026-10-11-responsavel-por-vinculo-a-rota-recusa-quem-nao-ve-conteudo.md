# O responsável e a pessoa da subtarefa, ditos por vínculo: a rota recusa quem não vê Conteúdo, e a decisão de `ownerUserId` vale só até aqui

**Data.** 2026-10-11

**Contexto.** A decisão `2026-10-11-responsavel-do-conteudo-pelo-vinculo-na-api` (#552) diz que um vínculo "de quem não vê Conteúdo" é `400 CONTENT_OWNER_INVALID`, com o gatilho `A0073` do banco como "segunda barreira". Na prática só o gatilho recusava esse caso: a rota resolvia o vínculo por `agency_memberships` (ativo, da agência) e deixava a pessoa que não lê Conteúdo chegar ao `UPDATE`, onde o gatilho a recusava depois de a transação já ter escrito o resto. A revisão do #561 deixou isso como baixa (issue #566), junto de duas outras: o teste que procura o id de usuário nas respostas não incluía as pessoas do portal nem as das fixtures das transições, e as decisões antigas que falam de `ownerUserId` não apontam a nova.

**Decisão.**
1. **A rota recusa o vínculo de quem não vê Conteúdo, antes de escrever.** `resolveCollaboratorLink` (a leitura única do vínculo, que as rotas de criar e editar o conteúdo e as de criar e editar subtarefa usam) devolve a pessoa só se o vínculo é ativo, é desta agência e a pessoa lê Conteúdo: é a dona da agência, ou o papel do vínculo (de sistema ou da própria agência) tem `conteudo.visualizar`. É a mesma regra do gatilho (`app_private.agency_user_can`), e a resposta é a mesma de antes, `400 CONTENT_OWNER_INVALID` (`CONTENT_TASK_ASSIGNEE_INVALID` na subtarefa), com a mesma mensagem para qualquer motivo. O gatilho `A0073` continua sendo a segunda barreira.
2. **Por que não chama `agency_user_can`.** `ageniza_app` não executa a função (só o dono do banco, pelos gatilhos), e dar `EXECUTE` a ela seria migration e decisão de autorização à parte. A rota lê o mesmo dado das tabelas que a RLS já mostra a quem é da agência (`agencies`, `agency_memberships`, `roles`, `role_permissions`). A agência ativa fica por conta do guard da rota, que já a exige.
3. **A cópia é presa por teste, não por construção**, como a decisão `2026-10-10-a-api-le-a-autorizacao-de-agencia-de-uma-funcao-e-a-rls-nao` faz com as outras: uma matriz compara a resposta da rota com `agency_user_can` para as pessoas do cenário (Admin, Gestor, Produção, Vendas, Financeiro, papéis de uma permissão só, quem tem papel sem Conteúdo e quem tem a de Conteúdo), o Owner da agência com um vínculo de papel sem Conteúdo (aceito, como no banco) e um vínculo cujo papel é de outra agência (recusado, como no banco).
4. **A busca por vazamento de id cobre todo o cenário:** as pessoas do mundo, as das fixtures das transições e as do portal, que aparecem como aprovador, responsável ou pessoa de uma subtarefa. O teste lê a lista de ids na hora de conferir, e não uma lista fixa.
5. **Onde vale a decisão nova e onde valem as antigas.** Valem as de 2026-10-11 de #552 como estão. As que falam de `ownerUserId` e não se editam:
   - `2026-10-11-conteudo-editar-aceita-responsavel-e-lista-de-midia-na-mesma-chamada`, itens 1 e 3 (o corpo do `PATCH` com `ownerUserId` e a troca do responsável): o que vale hoje é o corpo com **`ownerMembershipId`**, o vínculo, e a permissão `conteudo.aprovar_pela_agencia` para trocar, que o item 3 mantém.
   - `2026-10-11-toda-edicao-de-conteudo-trava-o-cliente-ativo`, item 1 (a lista de colunas do gatilho de edição, que cita `owner_user_id`): continua certa, porque é a **coluna** do banco; a API nunca mais a expõe.
   - `2026-10-11-responsavel-do-conteudo-pelo-vinculo-na-api`: é a decisão que esta completa. Ela substituiu o campo `ownerUserId` da API por `owner` e `ownerMembershipId`; esta fecha a promessa de que quem não vê Conteúdo é recusado pela rota.
   A coluna `contents.owner_user_id` e a `content_tasks.assignee_user_id` seguem sendo ids de usuário no banco; só a API fala por vínculo.

**Consequência.**
- Muda a ordem do que o cliente da API vê só num caso: vínculo de quem não lê Conteúdo, que antes escrevia e desfazia pela exceção do gatilho e agora é recusado antes de qualquer escrita (mesmo código e mesma mensagem). Nada novo para a tela.
- A rota passa a ter mais uma cópia de "quem vê Conteúdo", além de `has_agency_permission`, `agency_permission_keys` e `agency_user_can`, que a decisão de 2026-10-10 já prende por teste; a matriz acima é o que prende esta, e uma mudança na regra do banco exige mexer nela.
- Não há migration.

**Origem.** Issue #566, baixas da revisão de código do PR #561 (#552, Garça).

**Validação.** Pendente de validação do dono.
