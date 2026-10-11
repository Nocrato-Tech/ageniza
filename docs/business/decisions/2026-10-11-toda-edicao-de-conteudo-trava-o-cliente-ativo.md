# Toda edição de conteúdo trava o cliente ativo, e o ciclo com o arquivamento continua sendo o aceito

**Data.** 2026-10-11

**Contexto.** A regra 14 de `specs/conteudo.md` diz que o conteúdo de cliente arquivado é só leitura na agência. A decisão de 2026-10-07 (`2026-10-07-arquivar-o-cliente-cancela-o-conteudo-e-trava-as-filhas.md`) serializou com o arquivamento o `INSERT` do conteúdo e a mudança de `publish_on`, mas não as demais edições. Um `UPDATE` de legenda, título, capa, formato, horário, pasta ou responsável lê o cliente como ativo pelo instantâneo da própria instrução, e podia commitar depois de um arquivamento ainda não confirmado: o conteúdo aprovado de um cliente arquivado voltava a "aguardando aprovação", com a revisão incrementada, e o aviso de e-mail da fila (#252) o enfileiraria. Achado do PR #407, issue #408.

**Decisão.**

1. O gatilho `0_contents_move_lock_active_client` (só `publish_on`) é substituído por `0_contents_edit_lock_active_client`: `AFTER UPDATE OF title, format, publish_on, publish_at_time, caption, folder_id, cover_asset_id, owner_user_id`, por linha, e só quando um desses valores muda (`WHEN` compara `OLD` e `NEW`). Ele chama a mesma função das dez filhas, `lock_active_client_of_child`, que toma o cliente `FOR SHARE` e relê o estado depois da espera. Um `UPDATE` que não muda nada não trava.
2. O arquivamento em curso é recusado com `A0020`, em `READ COMMITTED`. Em `REPEATABLE READ` e `SERIALIZABLE`, o `FOR SHARE` de uma linha de cliente alterada depois do instantâneo falha com `40001`. O arquivamento já confirmado antes da instrução continua sendo recusado pela policy `contents_update` (`42501`), que exige cliente ativo.
3. Estado e revisão não entram na lista: as funções que os escrevem (`lock_content_for_agency`, `approve_content`, `lock_content_task`, `set_content_media`) já tomam o cliente antes do conteúdo e leem o estado depois da espera (`A0061` para a agência, `A0060` para o portal), e o próprio arquivamento cancela o conteúdo só pelo `status`, o que não pode pedir o cliente que ele segura.
4. A ordem das travas de um `UPDATE` direto é "conteúdo, depois cliente", porque um gatilho de linha só roda com a linha do conteúdo já travada: é o inverso do arquivamento. O ciclo entre as duas é o que a decisão de 2026-10-10 (`2026-10-10-o-ciclo-de-travas-do-arquivamento-ocorre-tambem-com-duas-instrucoes.md`) já aceita: o PostgreSQL o desfaz com `40P01`, a rota de arquivar responde `409 TRY_AGAIN` e quem chamou repete. Nenhuma função nova toma a ordem contrária.

**Alternativa fechada.** Tomar o cliente antes da linha do conteúdo num `UPDATE` direto exigiria um efeito colateral dentro da condição `USING` da policy (que roda antes da trava da linha) ou trocar a escrita direta por funções, o que muda como a API escreve e é mudança estrutural. Não foi adotado.

**Consequência.**

- Uma migration nova, `20261011000400_content_edits_lock_the_active_client.mjs`, que só troca o gatilho: nenhuma tabela, coluna, policy ou grant muda, e não há backfill.
- A API do conteúdo mapeia `A0020` para `409` (#254); nada muda em `apps/api`.
- O teste que dizia que uma mudança que não toca a data não trava o cliente passa a dizer o contrário, e a variante "não muda nada" ocupa o lugar dele.
- A fila de notificação (#252) fica protegida pela mesma ordem: o gatilho da trava (`0_`) dispara antes do de enfileirar, e a edição recusada não enfileira.

**Origem.** Issue #408, achado do Quartzo no PR #407 e comentário do maestro; issue #403 no mesmo PR agrupado (só testes).

**Validação.** Pendente de validação do dono.
