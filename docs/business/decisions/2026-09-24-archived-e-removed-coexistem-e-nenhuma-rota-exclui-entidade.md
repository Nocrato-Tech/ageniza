# `archived` e `removed` coexistem, e nenhuma rota exclui entidade de negócio
**Data.** 2026-09-24

**Contexto.** `clients.status` usa `active | archived` e `agency_memberships.status` usa `active | removed`. Dois vocabulários já conviviam sem regra escrita, e `structural-changes.md` registrava que definir exclusão depois de vários módulos escreverem o próprio jeito é o caminho mais caro.

**Decisão.** Os dois termos permanecem, com significados distintos: **`archived`** é a entidade de negócio guardada e recuperável; **`removed`** é o vínculo entre pessoa e tenant desfeito. Entidade usa `archived`, vínculo usa `removed`. E a regra dura: **nenhuma rota da aplicação exclui fisicamente entidade de negócio.** Purga real existe apenas no fluxo de retenção e LGPD, que é separado e não passa por rota de produto.

**Consequência.** Toda entidade de negócio nova nasce com `status` e um estado terminal reversível; quem quiser um `DELETE` de verdade precisa reabrir esta decisão. Unificar os dois termos depois seria migration em toda tabela que já os usa.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

