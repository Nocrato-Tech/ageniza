# `ageniza_app` não tem UPDATE nem DELETE onde nenhuma policy escreve

**Data.** 2026-10-07

**Contexto.** `agencies`, `agency_storage_quotas`, `roles`, `role_permissions` e `permissions` não têm policy de `UPDATE` e nada na aplicação as atualiza, mas `ageniza_app` mantinha `UPDATE` em todas as colunas, e `DELETE`, herdados de `20260919000000` e dos privilégios padrão. Hoje só a RLS nega; a primeira policy de `UPDATE` que alguém escrever herdaria um grant que cobre `agencies.owner_user_id` ou `role_permissions.permission_key`, que é o desenho da escalada do Gestor de conta descrita em `docs/security-review.md` (issue #296). A #356 já revogou o `DELETE` de `agency_memberships` e `invitations` e deixou as demais tabelas para esta issue; a #343 já revogou `INSERT`, `UPDATE` e `DELETE` de `legal_acceptances`.

**Decisão.** Uma migration (`20261007000700`) revoga `UPDATE` e `DELETE` de `ageniza_app` nas cinco tabelas acima e `DELETE` em `client_memberships`, que mantém o `UPDATE` por coluna do onboarding. `media_assets` perde o `DELETE` na mesma migration (ver a decisão do estado do envio de mídia). Nenhuma remoção de entidade de negócio é caminho da API: remover é mudar `status`. Os testes afirmam `has_table_privilege` e `has_any_column_privilege` falsos, a lista exata de colunas graváveis de `client_memberships`, e que o privilégio sozinho recusa quando uma policy permissiva é criada por engano numa transação revertida.

**Consequência.** `SELECT ... FOR UPDATE` exige `UPDATE` em alguma coluna, então `ageniza_app` não consegue mais nem tentar travar uma linha de `agencies`; o lock da cota de mídia já era advisory, e o teste que provava "o lock de linha é filtrado pela RLS" passou a provar "o lock de linha é recusado pelo privilégio". As asserções de `tenancy.integration.test.ts` que esperavam `0` linhas passaram a esperar `permission denied for table …`, no mesmo precedente da #356. `INSERT` nessas cinco tabelas segue concedido e protegido só pela ausência de policy de `INSERT`: não estava na issue e fica como pendência. Não é estrutural pelos cinco critérios; o gate de CI o trata como estrutural por conter `revoke`.

**Origem.** Issue #296, por decisão do maestro com a autonomia dada pelo dono do produto em 2026-10-07.

**Validação.** Pendente de validação do dono.
