# O ator de cada transação é gravado uma vez pelo banco, e não pelo GUC `app.user_id`
**Data.** 2026-09-30

**Contexto.** A entrada de 2026-09-29 ("O SQL do papel de runtime (ageniza_app) é confiável") aceitou provisoriamente que o `app.user_id` é forjável por `ageniza_app` e deixou o endurecimento real para a #166, que precisa entrar antes da #97. O ataque provado na re-revisão do PR #159: dentro de uma transação já autenticada como Gestor de conta, um `set_config('app.user_id', <Owner>, true)` no meio da instrução faz toda a autorização passar a responder como o Owner, e o Gestor concede `admin`. Qualquer caminho que injete um fragmento de SQL numa transação autenticada, por exemplo uma injeção de SQL numa rota futura, herda essa escalada no produto inteiro. Todas as funções `security definer` e todas as policies leem o ator por `app_private.current_user_id()`, que hoje só lê o GUC. **É mudança estrutural:** muda como a autorização é avaliada em todos os módulos.

**Decisão.** O ator deixa de viver num GUC e passa a viver numa tabela que só o banco escreve, com uma linha por transação, gravada uma única vez.

1. **`app_private.actor_context`**: tabela `unlogged` com `xact_id xid8 primary key`, `user_id uuid not null` e `bound_at timestamptz not null default now()`. O `ageniza_app` não tem nenhum *grant* nela: não lê, não insere, não altera, não apaga.
2. **`app_private.bind_actor(user_id uuid)`**: função `security definer`, com `search_path = ''` e `revoke … from public`. O `ageniza_app` só tem `execute`. Ela grava `(pg_current_xact_id(), user_id)`. Se a transação já tem ator, a chave primária colide e a função levanta `42501`. **Não existe troca de ator dentro de uma transação**, nem para o mesmo usuário. Ator nulo também é recusado.
3. **`app_private.current_user_id()`**: é recriada em migration nova, sem editar a aplicada. Passa a ser `security definer` e devolve o `user_id` da linha cujo `xact_id` é o `pg_current_xact_id_if_assigned()` da transação corrente. Sem `bind_actor`, devolve nulo, e a RLS não mostra nenhuma linha de tenant, como hoje sem o GUC. O nome e a assinatura não mudam, então as policies e as funções que a chamam continuam iguais.
4. **`withAuthenticatedUserTransaction`**, em `packages/database`, troca o `set_config` por `select app_private.bind_actor(?)`, como **primeira instrução** da transação e fora de qualquer *savepoint*. O worker e o `seed:demo` já passam por essa função. O `app.user_id` deixa de ser lido em qualquer lugar: forjá-lo não tem mais efeito.
5. **Limpeza.** O `xid8` nunca se repete, então uma linha de transação encerrada não é perigosa, só ocupa espaço. Uma função `security definer`, `app_private.purge_actor_context()`, apaga as linhas com mais de uma hora e é chamada pelo worker de tempos em tempos. Como a tabela é `unlogged`, a escrita por requisição não gera WAL.

**Por que o `ageniza_app` não consegue forjar.**
- Ele não escreve na tabela: o *grant* não existe (provado em protótipo: `permission denied`).
- Ele só grava por `bind_actor`, e ela só aceita **uma** gravação por transação. A aplicação grava primeiro, a partir da sessão verificada. Qualquer fragmento de SQL que rode depois na mesma transação, inclusive dentro da mesma instrução, recebe `42501` ao tentar gravar de novo (provado em protótipo).
- O GUC fica sem efeito: `set_config('app.user_id', …)` continua executando, mas nada o lê (provado em protótipo: o `set_config` para outro usuário não muda o que a RLS mostra).
- A chave é o `xid8` da transação, que é global e nunca se repete. Uma transação não enxerga o ator de outra, nem numa conexão reaproveitada do pool.

**O que continua confiável, e fica dito.** Quem tem a **credencial** do `ageniza_app` e abre as próprias transações pode chamar `bind_actor` com qualquer usuário na primeira instrução. Nenhum mecanismo dentro do banco impede isso enquanto o mesmo papel também lê e escreve `auth.session` (o Better Auth precisa disso). Exigir o token de sessão em `bind_actor` não resolveria, porque o mesmo papel lê os tokens. Portanto:
- a **credencial do banco** continua sendo segredo de servidor (AGENTS.md);
- o que a #166 elimina é a escalada **dentro de uma transação já autenticada**, que é a forma que uma injeção de SQL ou um fragmento hostil teria;
- a premissa "o papel de runtime é confiável" da entrada de 2026-09-29 fica **restrita ao primeiro bind de cada transação**, e deixa de valer para o resto dela.

**Armadilha achada no protótipo.** Um `bind_actor` feito **dentro** de um *savepoint* é desfeito por `rollback to savepoint`, e um segundo bind passa a ser aceito. Por isso o item 4 exige o bind na transação de topo, antes de qualquer trabalho, e a implementação precisa de teste que prove essa ordem em `withAuthenticatedUserTransaction`. Nenhuma função do banco chama `bind_actor`.

**Consequência.**
- Toda transação autenticada passa a consumir um id de transação, mesmo as só de leitura. O custo é aceito, e o PR mede o tempo das suítes de integração antes e depois.
- `current_user_id()` vira `security definer` com uma consulta por chave primária. O PR confere que nenhuma policy ficou visivelmente mais lenta.
- Tabela `unlogged` some num crash e não vai para réplica. Os dois casos são aceitáveis, porque o ator só vale dentro de uma transação viva, e hoje não há réplica de leitura.
- Todo fluxo que hoje troca o `app.user_id` dentro de uma transação precisa virar duas transações. A implementação faz esse inventário e o descreve no PR.
- Os testes que forjam `app.user_id` passam a provar que o forjamento **não** tem efeito. Nenhum teste existente é removido.
- A alegação de imunidade a "any GUC trick" não pode continuar no código fora de migrations aplicadas.
- A #97 fica liberada quando a #166 entrar.

**Origem.** Issue #166; re-revisão de segurança do PR #159. Opção 1 escolhida pelo dono do produto em 2026-09-30. O desenho foi prototipado num banco descartável antes da implementação. Desenho aprovado pelo dono do produto em 2026-09-30.

