# ESTRUTURAL: o autor de um comentário é lido por uma função `security definer`, pelo vínculo do lado do comentário

**Data.** 2026-10-07

**Contexto.** A conversa com o cliente (#128, lado da agência, e #130, lado do portal) mostra em cada comentário o nome e a foto de quem o escreveu. A SPEC de clientes (seção 5, regra 16) manda ler esses dados **através do comentário**, nunca por `auth."user"` solto, e `auth."user"` não tem RLS. O nome exibido é o do **vínculo**: `agency_memberships` para o lado `agency`, `client_memberships` para o lado `client`. Só que, sob RLS, a pessoa do portal não lê esses vínculos: `agency_memberships_select` mostra os vínculos de uma agência só a quem é membro dela, e `client_memberships_select` mostra os de um cliente só ao próprio dono do vínculo ou à agência. A pessoa do portal nunca veria o nome de quem da agência respondeu, nem o de outra pessoa do mesmo cliente. As duas rotas não podiam compartilhar uma consulta de autor.

**Decisão.** Uma função `app_private.thread_comment_authors(p_thread_id uuid)`, `security definer`, de escopo único, é o **único** caminho de leitura de autor, usado pelos dois lados. Ela devolve, para uma thread, quem comentou nela e quem a resolveu (sempre do lado `agency`), e nada além disso: `author_user_id`, `author_side`, `name` e `photo_key`. Cada comentário se amarra ao vínculo **do lado dele**: `agency_memberships` da agência do cliente se o lado é `agency`, `client_memberships` daquele cliente se é `client`. Uma pessoa sem vínculo naquele lado não resolve nome, mesmo que exista em `auth."user"`.

O acesso usa **exatamente** o predicado da policy `client_threads_select`, montado com as mesmas funções que ela chama (`is_agency_member`, `is_client_member`, `client_agency_id`) e a mesma regra de persona ativa para o portal. Quem não lê a thread recebe **zero linhas**, igual a uma thread que não existe: a função não é oráculo de existência. `EXECUTE` é só de `ageniza_app` (revogado de `public`), com `search_path` vazio e todo objeto qualificado, como as demais funções `security definer` do repositório.

**Vínculo removido mantém o nome.** O comentário é histórico: a pessoa que saiu da agência, ou foi removida do portal, continua assinando o que escreveu. Quem não pode mais ler a thread (porque o próprio vínculo foi removido) não recebe nada, mas os demais continuam vendo o nome dela.

**Consequência.** Toda leitura de autor de conversa passa por essa função. Quando Conteúdo acrescentar `content_id` como assunto da thread, a função continua valendo sem mudança, porque parte da thread. O predicado de leitura vive agora em dois lugares, a policy e a função, e o teste de banco compara os dois para cada combinação de pessoa e thread: mudar um sem o outro quebra o teste. O dono da agência sem linha em `agency_memberships` (caso legado) não tem vínculo de onde ler o nome, e o autor dele aparece sem nome, nunca inventado.

**Origem.** Issues #128 e #130, seção 5 (regra 16) e seção 6 de `specs/clientes.md`. Migration `20261007000800_thread_comment_authors.mjs`. Decisão do maestro, tomada na implementação.

**Validação.** Pendente de validação do dono.
