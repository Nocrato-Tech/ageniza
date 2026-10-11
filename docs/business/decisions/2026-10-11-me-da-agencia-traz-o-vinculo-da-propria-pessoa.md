# O /me da agência traz o vínculo da própria pessoa

**Data.** 2026-10-11

**Contexto.** O responsável de um conteúdo é dito pelo vínculo, `owner: { membershipId, name }`, e nenhuma resposta de Conteúdo dá o id de usuário de alguém (`2026-10-11-responsavel-do-conteudo-pelo-vinculo-na-api.md`). Para saber se a pessoa logada é o responsável (aprovar subtarefa, #265), a web precisa do vínculo da própria pessoa na agência ativa, e `GET /agencies/:agencyId/me` não o trazia.

**Decisão.** `GET /agencies/:agencyId/me` passa a trazer `membershipId`: o id do vínculo ativo da própria pessoa **na agência pedida** (uma pessoa de duas agências recebe o de cada uma), ou `null` para o Owner que é dono só por posse, sem vínculo. A web compara com `owner.membershipId` do conteúdo; nenhum id de usuário sai na resposta. A mudança é aditiva: nenhum campo existente muda, e a guarda e a RLS continuam sendo a autorização (o campo é entrada de UX, como as permissões).

**Consequência.**
- O contrato (`AgencyMeResponse`), o catálogo e `docs/api` ganham o campo; nenhuma migration.
- `null` não identifica ninguém: um conteúdo cujo responsável é um Owner sem vínculo também tem `owner: null`, e a web não pode tratar `null` igual a `null` como "sou o responsável".

**Origem.** Pedido do maestro para a #265.

**Validação.** Pendente de validação do dono.
