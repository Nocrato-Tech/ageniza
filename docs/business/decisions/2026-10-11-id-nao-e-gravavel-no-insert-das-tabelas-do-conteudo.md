# O `id` deixa de ser gravável no INSERT das tabelas do Conteúdo em que nenhum código o escolhe

**Data.** 2026-10-11

**Contexto.** A lição de grants do projeto é que `id` nunca é gravável: quem escolhe a chave da própria linha pode colidir com uma chave de que outra parte deriva coisas, ou ocupá-la antes. A revisão de segurança do PR #575 (Coruja) achou o `INSERT (id, ...)` de `content_tasks` aberto para `ageniza_app`, e a issue #580 pediu conferir as demais tabelas do módulo. O catálogo mostra o `id` gravável por coluna em dez tabelas de `public`. Em cinco delas (`contents`, `content_tasks`, `story_scripts`, `story_script_scenes`, `media_folders`) nenhum código da API, do worker ou do seed escolhe o id: cada `INSERT` lê o id de volta com `returning id`. Nas outras cinco, o código passa o id.

**Decisão.**
1. **Migration `20261011000900`:** `revoke insert (id)` nas cinco tabelas em que nenhum código passa o id. O default (`gen_random_uuid()`) fica, o `SELECT` do id também, e nada mais muda: o instantâneo do catálogo de grants, antes e depois, difere só nas cinco linhas `INSERT` do `id`. Um `INSERT` que nomeia o id é `42501`.
2. **Cinco exceções, nomeadas e com a issue que as retira (#601):** `media_assets` (a API gera o id antes, porque `object_key` e `upload_object_key` são montados com ele e não têm `UPDATE`), `client_threads` (o serviço de conversa passa o id da conversa), `client_thread_comments`, `clients` e `client_personas` (o seed da demonstração, que roda como `ageniza_app`, passa ids determinísticos para ser idempotente). Elas ficam numa lista permitida explícita no teste de catálogo, cada uma com o motivo.
3. **O teste de catálogo lê o esquema `public` inteiro:** qualquer tabela, nova ou antiga, que volte a aceitar `id` no INSERT e não esteja na lista, deixa o teste vermelho; e uma exceção que foi corrigida e continua na lista também. Quando a #601 resolver cada uma, ela sai da lista.
4. **`content_media` não tem coluna `id`** (a chave é composta) e **`notification_queue` já não tem `INSERT` para o papel**: nenhuma das duas precisa de revoke.

**Consequência.**
- Os testes de banco que escolhiam o id como `ageniza_app` nessas cinco tabelas passam a ler o id do `returning`; nenhum teste foi removido nem enfraquecido (os de "recusa sem deixar linha" confirmam a ausência pelo título ou pela contagem, e os de grants por coluna ficam mais estritos).
- A migration não muda dados nem o formato de nenhuma resposta; nenhum código de produção muda.
- Quem escrever um `INSERT` novo nessas tabelas com o id explícito recebe `42501`.

**Origem.** Issue #580, observação da revisão de segurança do PR #575 (Coruja); exceções em #601.

**Validação.** Pendente de validação do dono.
