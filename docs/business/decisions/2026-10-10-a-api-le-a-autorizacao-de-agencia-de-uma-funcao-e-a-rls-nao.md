# A API lê a autorização de agência de uma função, e a RLS não

**Data.** 2026-10-10

**Estrutural.** Esta decisão é estrutural segundo [structural-changes.md](../structural-changes.md): muda como a autorização é avaliada e redefine `app_private.has_agency_permission`, a função que sustenta a RLS de toda tabela de agência.

**Contexto.** O que uma pessoa pode fazer numa agência era resolvido em três lugares que precisam concordar: `app_private.has_agency_permission` (o que a RLS lê), `createRequireAgencyAccess` em `apps/api/src/modules/tenancy/guards.ts` (que monta `request.tenant.permissions`) e `loadAgencyMe` em `apps/api/src/modules/agencies/service.ts` (que serve `GET /agencies/:agencyId/me`). Uma mudança em quem tem o quê (status de vínculo novo, papel desativado, regra de posse) feita numa cópia e esquecida nas outras não tinha teste que a pegasse. Havia ainda uma diferença real entre elas: para o Owner, o SQL respondia `true` a **qualquer texto**, a API deixava passar qualquer chave por `isOwner` e `/me` devolvia o catálogo inteiro. Origem: issue #189, seguimento da revisão do PR #186.

**Decisão.**

1. **`app_private.agency_permission_keys(p_agency_id uuid) returns setof text` é a leitura única das chaves** que a API usa. É `STABLE`, `SECURITY DEFINER`, `search_path` fixo, `EXECUTE` só para `ageniza_app`, sem `PUBLIC`. Não recebe pessoa: responde pela pessoa ligada à transação, então ninguém consulta o que outra pessoa tem. Quem não é Owner nem vínculo ativo de agência ativa recebe o conjunto vazio, a mesma resposta de uma agência que não existe. O Owner de agência ativa recebe todas as chaves de `public.permissions`, inclusive `colaborador.atribuir_admin`, que nenhum preset carrega; os demais recebem as chaves do papel do vínculo ativo, com o papel restrito a `role.agency_id is null or role.agency_id = agency.id`.
2. **A RLS não chama essa função.** `has_agency_permission` mantém o corpo direto, com a mesma assinatura, volatilidade, `SECURITY DEFINER` e `search_path`, então nenhuma policy e nenhum grant mudam. Quem propuser definir `has_agency_permission` a partir de `agency_permission_keys` ("as leituras concordam por construção") **deve refazer a medição abaixo antes de qualquer migration**.
3. **O Owner só tem a chave que existe no catálogo (fail closed).** O ramo do Owner de `has_agency_permission` ganhou `exists (select 1 from public.permissions where key = p_permission)`, uma busca por chave primária. Antes, `has_agency_permission(agencia, 'qualquer.texto')` era `true` para o Owner; agora é `false`. Nenhuma policy nem função pede chave fora do catálogo (o teste de banco lista as chaves literais de toda chamada de `has_agency_permission`, `lock_content_for_agency` e `agency_user_can` em `pg_policies` e `pg_proc` (inclusive quando o primeiro argumento é uma chamada, como `client_agency_id(client_id)`, e exigindo que nenhuma chamada de policy fique sem chave extraída) e confere que existem), então só muda um erro de digitação em policy futura: passa a falhar fechado em vez de abrir em silêncio para o Owner.
4. **A guarda da API mantém o atalho do Owner.** `requirePermission` e `tenantHolds` continuam liberando `isOwner` sem olhar a chave, e o teste existente de `guards.test.ts` com a chave `'anything'` continua valendo. O que muda, na API (outro PR, que depende deste), é só a origem de `request.tenant.permissions` e da lista de `/agencies/:id/me`: ambas passam a ler `agency_permission_keys`.
5. **As duas leituras são presas por teste, não por construção.** `packages/database/test/agency-permission-keys.integration.test.ts` compara, para cada chave do catálogo e para cada pessoa de uma matriz (Owner com e sem vínculo, Admin, papéis personalizados de uma e de duas chaves, papel de outra agência, vínculo removido, pessoa de duas agências, agência suspensa, sem vínculo, sem pessoa ligada), a resposta de `has_agency_permission` com o conjunto de `agency_permission_keys`. A matriz inclui a agência suspensa (Owner e Admin) e a pessoa de duas agências, comparada em cada uma. Um teste confere que o corpo de `has_agency_permission` não cita `agency_permission_keys`.
6. **`app_private.agency_user_can` é a terceira cópia em SQL e entra na mesma matriz.** Ela vem da migration `20261007001200_contents.mjs` (migration aplicada não se edita), recebe a pessoa por argumento e só os gatilhos de Conteúdo a chamam, com o literal `conteudo.visualizar`, para conferir que o dono e o responsável de um conteúdo são colaboradores que o veem; só o dono do banco executa. O teste de banco a compara com `agency_permission_keys` para cada pessoa e cada chave do catálogo. Ela **não** ganha o fail closed do Owner nesta mudança: isso pediria outra redefinição de função de autorização, e hoje nada a chama com chave fora do catálogo.
7. **O rótulo do papel em `contexts/service.ts` fica como está.** `fetchAgencyContexts` junta vínculo e papel só para mostrar `role_key` e `role_name`; não decide permissão. Uma mudança no escopo do papel precisa ser espelhada ali à mão. Está documentado aqui para quem mexer no escopo do papel.

**Medição que motivou o item 2.** Banco isolado, 20 mil linhas em `media_assets` e 20 mil em `invitations` (uma agência), `ageniza_app` sob RLS, `EXPLAIN (ANALYZE, TIMING OFF) select count(*)`, mediana de 9 execuções, linhas visíveis idênticas (20000) antes e depois em todos os casos. A policy de `invitations` chama `has_agency_permission` até quatro vezes por linha.

| Pessoa e tabela | Corpo direto (ms) | `has_agency_permission` chamando `agency_permission_keys` (ms) | Razão |
|---|---|---|---|
| Owner, mídia | 605 | 7 598 | 12,6x |
| Owner, convites | 581 | 7 215 | 12,4x |
| Admin, mídia | 1 113 | 6 996 | 6,3x |
| Admin, convites | 1 101 | 7 883 | 7,2x |
| Papel de uma permissão, mídia | 1 191 | 6 803 | 5,7x |
| Papel de uma permissão, convites | 4 403 | 19 735 | 4,5x |

A causa é a chamada, não a consulta: uma função `SECURITY DEFINER` que chama outra não pode ser expandida pelo planejador, e a policy a executa uma vez por linha (cerca de 330 µs por chamada, contra cerca de 30 µs do corpo direto). Uma variante que empurra o filtro da chave para dentro de `agency_permission_keys` ficou igual (13,7 s contra 14,1 s num teste com o predicado repetido). O custo do que ficou, medido no mesmo banco antes e depois da migration:

| Pessoa e tabela | Antes (ms) | Depois (ms) |
|---|---|---|
| Owner, mídia | 589 | 702 (outras três rodadas: 660, 688, 788) |
| Owner, convites | 674 | 692 |
| Admin, mídia | 1 318 | 1 177 |
| Admin, convites | 1 186 | 1 222 |
| Papel de uma permissão, mídia | 1 192 | 1 152 |
| Papel de uma permissão, convites | 3 440 | 3 681 |

Só o Owner paga o `exists` do item 3: cerca de 5 µs por chamada (20 mil chamadas alternadas do corpo antigo e do novo, com o argumento volátil para o planejador não içar a chamada: 602 contra 713 ms, +18%), de modo que a listagem de mídia do Owner fica entre +10% e +30% (ruído da máquina compartilhada) e a de convites, +3%. Os demais ficam dentro do ruído de ±10 a 25% do próprio banco.

**Consequência.**

- Uma regra nova de "quem tem o quê" (status de vínculo novo, papel desativado) passa a ser feita em **três** lugares no SQL, `has_agency_permission`, `agency_permission_keys` e `agency_user_can`, e o teste de banco derruba a suíte se divergirem. Em troca, a API deixa de ter cópia própria do join.
- `has_agency_permission(agencia, chave)` do Owner para chave fora do catálogo muda de `true` para `false`. Nenhuma rota, contrato ou resposta muda; `pnpm api:docs` não muda.
- A função e o teste são aditivos: nenhuma tabela, policy, grant ou dado muda, e não há backfill.
- A migration é `20261010000600_agency_permission_keys.mjs`; o prefixo foi reservado pelo dono.

**Alternativas fechadas.** Definir `has_agency_permission` a partir de `agency_permission_keys` (item 2, com a medição acima). Um cache das chaves por transação, escrito pelo banco como o `actor_context`: reabre a decisão a cada nova tabela de permissão e aumenta a superfície de ataque. Quem voltar a propor qualquer uma precisa de um motivo novo.

**Origem.** Issue #189; revisão de segurança do PR #186 (achado 4) e a re-revisão, que acrescentou o rótulo de `contexts/service.ts` (item 7).

**Validação.** Validada pelo dono em 2026-10-10.
