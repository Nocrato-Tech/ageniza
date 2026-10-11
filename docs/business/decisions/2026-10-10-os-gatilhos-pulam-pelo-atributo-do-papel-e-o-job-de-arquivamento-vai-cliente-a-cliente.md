# Os gatilhos pulam pelo atributo do papel, e o job de arquivamento vai cliente a cliente

**Data.** 2026-10-10

**Estrutural.** Sim: reescreve cinco funções de gatilho que atravessam módulos (clientes, convites, colaboradores, mídia e Conteúdo) e muda a forma como o job do arquivamento chama o banco. Não altera tabela, coluna nem policy, e não precisa de backfill.

**Contexto.** Achados Baixos do PR #393 (revisão de segurança da Coruja), registrados na #397.

1. Cinco funções de gatilho decidiam quem governam comparando um nome com `'ageniza_app'`: `check_agency_membership_update`, `invitation_state_is_forward_only`, `media_asset_upload_state_is_forward_only` e `story_script_scenes_guard_write` comparam `current_user`; `lock_active_client_of_child` (a trava do arquivamento nas dez tabelas filhas do cliente, decisão de 2026-10-07) compara `session_user`, porque dentro de uma função `security definer` o `current_user` é o dono. Um login novo que não é a aplicação e não tem bypass (um *pooler*, um worker com outro login) era pulado pelas cinco: o `session_user` dele é o login, mesmo depois de `SET ROLE ageniza_app`, e o `current_user` dele não é `ageniza_app` quando ele só herda os *grants*. Falhava aberto.
2. A decisão de 2026-10-07 diz que o ciclo de travas (40P01) só é alcançável "dentro da janela de uma única instrução". A Coruja provou com duas (um `UPDATE` do conteúdo e depois um `INSERT` de subtarefa). O `archive_due_clients()` arquivava todos os clientes vencidos numa só chamada, portanto numa só transação: se o job perdesse o ciclo, a hora inteira era desfeita.

**Decisão.**

1. **Pelo atributo, nunca pelo nome.** Os gatilhos pulam só para um papel com `rolsuper` ou `rolbypassrls`, o que a RLS e os *grants* também não limitam. A conta é uma função nova, `app_private.role_bypasses_rls(name)`, que lê esse par de atributos de `pg_roles`; um papel que não existe é limitado (falso), então um erro de digitação ou um papel apagado falha fechado. As quatro funções de `current_user` perguntam por `current_user`; a de `session_user` pergunta pelo login, pelo mesmo motivo de antes. Um login com `rolbypassrls` que faz `SET ROLE ageniza_app` continua pulando a trava, como o dono: é um papel de operação, não a aplicação. Um teste varre o catálogo e reprova qualquer função de `public`, `app_private`, `audit` ou `auth` que compare `current_user` ou `session_user` com um literal.
2. **O job arquiva cliente a cliente.** O worker pede a lista de vencidos (`app_private.due_client_ids()`) e chama `app_private.archive_due_client(cliente)` uma vez por cliente, cada chamada uma transação curta. O deadlock (40P01) ou a falha de serialização (40001) de um cliente não derruba o lote: esse cliente continua vencido, fica para a hora seguinte e vai para o log com o seu id (um identificador opaco, sem dado pessoal), num aviso. Qualquer outro erro continua derrubando a execução, e a fila a repete. `archive_due_clients()` continua existindo, montada com as mesmas duas funções, e a regra de um cliente é uma só.
3. **A correção do texto de 2026-10-07 vai em arquivo novo**, `2026-10-10-o-ciclo-de-travas-do-arquivamento-ocorre-tambem-com-duas-instrucoes.md`, que cita a antiga; a antiga não é editada.

**Consequência.**

- Duas migrations novas, sem editar as anteriores: `20261010000300_triggers_skip_by_role_attribute.mjs` (a função auxiliar e as cinco funções substituídas por `create or replace`, lendo a definição do catálogo e trocando só a comparação, com dono e *grants* preservados) e `20261010000400_archive_due_clients_one_by_one.mjs`.
- Hoje o banco só tem `ageniza_app` (limitado) e `postgres` (superusuário), então o comportamento deles não muda. Quem criar um login novo escolhe: ou é membro de `ageniza_app` e fica limitado como ele, ou tem `rolbypassrls`/`rolsuper` e fica fora, conscientemente. Um papel sem nenhum dos dois que escreva nessas tabelas passa a ser governado pelos gatilhos, o que é o ponto.
- `due_client_ids()` e `archive_due_client(uuid)` são `security definer`, com `search_path` fixo, fechadas ao `PUBLIC` e abertas ao `ageniza_app`, como `archive_due_clients()` já era: são o escopo único dessa exceção. Qualquer sessão da aplicação, de qualquer agência, pode listar os ids de clientes cujo contrato já venceu e ainda não foram arquivados (uma janela de até uma hora) e disparar o arquivamento deles, que só acontece porque o relógio já passou. Os ids são UUID e a RLS continua a barrar a leitura de qualquer coisa do cliente, então não há dado de outra agência além do identificador. Fica registrado como risco aceito; fechar exigiria uma identidade de serviço, que a decisão de 2026-09-26 recusa.
- Os testes existentes que fixavam "as duas funções de arquivar chamam o auxiliar" e "o relógio vem de `sao_paulo_date`" passam a nomear `archive_due_client` e `due_client_ids`, com as mesmas listas exatas. O teste do worker que esperava a repetição de **toda** a execução depois de um deadlock é substituído, por esta decisão, pelo que ela manda: a execução termina, o cliente que perdeu fica para a próxima e os outros do lote são arquivados.

**Origem.** Issue #397; ressalvas Baixas da revisão de segurança do PR #393 (Coruja); decisão do dono em 2026-10-10 (comentário na issue).

**Validação.** Validada pelo dono em 2026-10-10.
