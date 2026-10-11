# `agency_user_can` também nega a chave que não existe no catálogo

**Data.** 2026-10-10

**Estrutural.** Esta decisão estende a de [a API lê a autorização de agência de uma função e a RLS não](2026-10-10-a-api-le-a-autorizacao-de-agencia-de-uma-funcao-e-a-rls-nao.md), que é estrutural segundo [structural-changes.md](../structural-changes.md) (muda como a autorização é avaliada). Aqui só se aplica a outra função de autorização a mesma regra já decidida; não há tabela, policy, grant nem dado novo.

**Contexto.** A decisão do #189 fez o Owner de `app_private.has_agency_permission` valer só para chave que existe em `public.permissions` (fail closed), e deixou `app_private.agency_user_can` de fora (item 6), por ser função de uma migration já aplicada e por nada a chamar com chave fora do catálogo. `agency_user_can(agência, pessoa, chave)` é a terceira cópia em SQL da mesma resolução, para uma pessoa passada por argumento: os gatilhos de Conteúdo (`contents_check_references` e `content_tasks_check_people`) a usam para conferir que o dono e o responsável de um conteúdo são colaboradores que o veem. Para o Owner ela respondia `true` a qualquer texto, diferente das outras duas. A revisão do PR #505 apontou a inconsistência e a issue #508 a registrou.

**Decisão.**

1. **O ramo do Owner de `agency_user_can` ganha o mesmo `exists (select 1 from public.permissions where key = p_permission)`**, uma busca por chave primária, pela migration `20261010000700_agency_user_can_closes_the_owner.mjs` (a migration `20261007001200_contents.mjs` não se edita). O corpo é o antigo com essa única adição, via `create or replace`: assinatura, volatilidade, `SECURITY DEFINER`, `search_path`, dono e ACL ficam como estavam (sem `EXECUTE` para `PUBLIC` nem para `ageniza_app`).
2. **O teste de paridade cobre a chave fora do catálogo nas três funções.** Para cada pessoa da matriz, `agency_permission_keys` não a devolve, e `has_agency_permission` e `agency_user_can` respondem `false`; um teste confere também os atributos de `agency_user_can`.

**Consequência.**

- Nada que estava aberto fecha: o único chamador passa o literal `conteudo.visualizar`, que está no catálogo (o teste de banco lista as chaves literais de toda chamada de `has_agency_permission`, `lock_content_for_agency` e `agency_user_can` e confere que existem). Só um erro de digitação futuro passa a falhar fechado.
- Custo: o `exists` roda só no ramo do Owner, cerca de 3 µs por chamada (18 rodadas alternadas de 20 mil chamadas com argumento volátil: 131 contra 186 ms). A função só roda nos gatilhos de escrita de Conteúdo, não por linha lida, então não há medição de RLS a refazer.
- As três funções do SQL (`has_agency_permission`, `agency_permission_keys` e `agency_user_can`) continuam sendo mantidas à mão e presas pelo mesmo teste de banco.

**Origem.** Issue #508; achado da revisão do PR #505 (#189).

**Validação.** Validada pelo dono em 2026-10-11.
