# O nome de quem gravou o roteiro sai de uma função de leitura de propósito único

**Data.** 2026-10-11

**Esta mudança só cria um objeto novo** (a função `app_private.story_script_recorder`), não altera tabela existente nem policy, e não faz backfill. O gate de `scripts/ci/verify-structural-decisions.mjs` olha para o `revoke … from public` que fecha a função nova, e este arquivo registra o que a migration `20261011000500` decide e que alguém tentaria de novo.

**Contexto.** A revisão do PR #378 (#248) pediu que a resposta de um roteiro gravado mostre quem o gravou, e a #258 implementa as rotas. Quem grava é qualquer pessoa ativa do portal do cliente, inclusive um colaborador que tem vínculo com ele ([`2026-10-07-conteudo-roteiro-de-stories-no-banco.md`](2026-10-07-conteudo-roteiro-de-stories-no-banco.md), item 3), então o nome mostrado é o da pessoa **pelo vínculo com este cliente**, como no autor do comentário ([`2026-10-07-autor-do-comentario-pelo-vinculo.md`](2026-10-07-autor-do-comentario-pelo-vinculo.md)). A RLS de `client_memberships` mostra a uma pessoa só o vínculo dela (e todos à agência), então uma pessoa do portal não consegue ler quem foi a outra que gravou, e `auth."user"` não tem RLS e não pode ser lida solta.

**Decisão.**
1. **Uma função de leitura**, `app_private.story_script_recorder(p_script_id uuid)`, `security definer`, `search_path` vazio, `revoke … from public`, `execute` só para `ageniza_app`. Devolve só `recorded_by` e `name`: nada mais da conta (nem e-mail nem foto).
2. **Quem pode perguntar** repete o predicado de leitura do roteiro: a agência com `conteudo.visualizar` (`has_agency_permission`) ou a pessoa ativa do portal do cliente (`is_client_member`). Quem não pode ler o roteiro recebe zero linhas, igual a um roteiro que não existe: a função não é oráculo.
3. **Só roteiro gravado responde.** Rascunho e roteiro apenas enviado não têm quem gravou (o `CHECK` da #248 amarra os dois), então respondem zero linhas, e o portal não aprende que um rascunho existe.
4. **O nome é o da pessoa pelo vínculo com ESTE cliente.** Uma pessoa sem vínculo com o cliente do roteiro, ou só com o de outro, não é nomeada. O vínculo removido depois **continua** respondendo: a gravação é história e o nome que a assinou fica.

**Consequência.**
- A API (#258) lê o nome por esta função nos dois lados, em vez de ler `client_memberships` pela RLS do chamador.
- Quando a listagem da agência (#254) devolver roteiro gravado, usa a mesma função.
- Mudar quem pode ler o roteiro (a policy `story_scripts_select`) obriga a mudar esta função junto: o predicado está repetido por desenho, como em `thread_comment_authors`.

**Origem.** Issue #258, requisito da revisão do PR #378, decidido na implementação a pedido do maestro.

**Validação.** Pendente de validação do dono.
