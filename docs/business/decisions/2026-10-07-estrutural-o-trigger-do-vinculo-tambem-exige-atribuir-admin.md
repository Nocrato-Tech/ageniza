# ESTRUTURAL: o trigger do vínculo também exige `atribuir_admin` quando o vínculo volta a `active` com papel `admin`

**Data.** 2026-10-07

**Esta é uma mudança estrutural**, por um dos cinco critérios de [structural-changes.md](../structural-changes.md): muda **como a autorização é avaliada** (uma regra que depende do valor concedido, de 2026-09-24) num ponto que ela não alcançava. Registrada junto da migration, no mesmo PR, a pedido do maestro.

**Contexto.** `app_private.check_agency_membership_update` (migration `20260928000000`) pede `colaborador.atribuir_admin` só quando `role_id` **muda** para o papel `admin`. Reativar um vínculo removido muda `status` e não `role_id`: quem foi Admin e volta como Admin mantém o mesmo `role_id` e passava pelo trigger sem a permissão, o que é justamente o que a regra "só o Owner concede Admin" existe para impedir. Hoje só a rota o impedia; um `UPDATE` direto de um Admin como `ageniza_app` era aceito. Achado ao implementar a #98, que cria esse caminho.

**Decisão.** Migration nova `20261007000100_reactivation_admin_grant` (a antiga não é editada): o mesmo trigger, substituído no lugar, passa a exigir `colaborador.atribuir_admin` também na transição `removed` → `active` com o papel `admin`, mude o `role_id` ou não, com mensagem própria do trigger (`colaborador.atribuir_admin is required to bring back a link with the admin role.`, `42501`). Só essa transição: editar o cargo de um Admin ativo, removê-lo ou reativar com papel comum não muda. O dono do schema e as funções `security definer` que ele possui (`accept_invitation`) continuam fora do trigger, como antes.

**Consequência.** A rota e o banco passam a recusar o mesmo caso, e um teste confere que concordam para cada ator. Nenhuma tabela, coluna, policy ou grant muda, e não há backfill: vínculos já ativos não são reavaliados. O reaceite de convite por quem foi removido segue pelo `accept_invitation`, que não passa por este trigger.

**Origem.** Issue #98, achado da implementação, decidido pelo maestro. **Pendente de validação** pelo dono do produto.

