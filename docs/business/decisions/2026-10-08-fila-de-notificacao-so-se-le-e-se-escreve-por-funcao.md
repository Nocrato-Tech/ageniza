# A fila de notificação só se lê e só se escreve por função

**Data.** 2026-10-08

**Esta é uma mudança estrutural.** É o primeiro mecanismo de notificação do produto, e o formato que os próximos tipos vão copiar (ponto 7 de `2026-10-01-conteudo-impacto-estrutural.md`). Acrescenta um gatilho à tabela `contents`, que já existe, e uma tabela que guarda e-mail de pessoas.

**Contexto.** A SPEC de Conteúdo (seções 8 e 9) pede um e-mail ao cliente, enviado pelo worker, para todas as pessoas ativas do portal, e diz que o desenho é uma fila: destinatário, tipo, cliente, referência e janela de agrupamento. O worker conecta como `ageniza_app`, sem usuário, e não pode ter acesso amplo (`structural-changes.md`, "Trabalho agendado sem requisição"). Uma fila com policy teria de deixar o worker ler o e-mail de pessoas que ele não conhece, e uma fila que a rota alimenta deixaria o corpo de uma requisição decidir quem recebe e-mail.

**Decisão.**
1. **`notification_queue` não tem privilégio algum para `ageniza_app`, tem RLS forçada e nenhuma policy.** Duas travas que negam sozinhas: um `grant` futuro continua mostrando zero linhas. Estado (`claimed_at`, `attempts`, `last_error`, `sent_at`, `discarded_at`) só muda pelas funções.
2. **Quem enfileira é o banco.** Um gatilho `AFTER UPDATE` em `contents`, `security definer`, dispara quando o conteúdo **passa** a "aguardando aprovação" (inclusive quando o próprio banco o devolve para lá porque a legenda mudou, regra 6) ou a "publicado". Nenhuma função que enfileira é concedida, e nenhuma rota escreve na fila. O gatilho não usa `UPDATE OF status`: gatilho com lista de colunas ignora a coluna que outro gatilho `BEFORE` altera.
3. **Destinatário é o vínculo ativo do portal** daquele cliente (`client_memberships`), nunca um `auth."user"` solto. Cliente arquivado e agência suspensa não geram item (regra 8). A fila é filha do cliente e tem o gatilho `AFTER INSERT` de travar cliente ativo (A0020), que toma o cliente `FOR SHARE` como todo escritor dele: uma edição que concorre com o arquivamento espera por ele e é recusada com o erro das outras filhas, em vez de deixar um item para um cliente arquivado.
4. **O worker lê e marca por três funções** (`claim_notification_batch(limite)`, `mark_notifications_sent(itens, token)` e `fail_notifications(itens, token, código)`), concedidas a `ageniza_app`. Como o worker é `ageniza_app`, as funções **recusam (42501) quem tem ator ligado à transação**: toda requisição da API liga um ator, o worker nunca liga, então a lista de endereços não é algo que uma requisição consiga pedir. Recusam também qualquer isolamento diferente de READ COMMITTED (40001), porque travam e releem.
5. **A claim devolve o que o e-mail precisa** (endereço, nome do cliente e da agência, título e data do conteúdo), porque o worker não lê mais nada. Cada claim devolve um **token** (`claim_token`), gravado nos itens que reivindicou: o arrendamento dura 10 minutos, depois disso outra claim pode pegar o item com **outro** token, e a resposta tardia do primeiro worker (`mark` ou `fail` com o token velho) não carimba nem solta nada, então o mesmo e-mail não sai duas vezes por causa de um arrendamento vencido. Um item é tentado no máximo 5 vezes.
6. **Um grupo (pessoa, cliente e tipo) é reivindicado por um worker só.** A claim escolhe os grupos um a um e toma um `pg_try_advisory_xact_lock` do grupo, que vale até o fim da transação; quem não consegue o lock pula o grupo. Sem isso, dois workers poderiam dividir um grupo (cada um sem ver o `claimed_at` ainda não confirmado do outro) e deixar dois e-mails do mesmo grupo em voo. A claim não trava a fila inteira, só os grupos que reivindica.
7. **O erro de uma falha é um código curto** (`^[a-z0-9_.:-]{1,64}$`), nunca o texto do provedor, que carrega o endereço do destinatário.

**Consequência.**
- A #260 (worker) chama as três funções sem ligar ator, e `mark_notifications_sent`/`fail_notifications` só valem para o que a claim entregou.
- Os próximos tipos de notificação acrescentam o tipo e a coluna de referência na tabela e a regra de quando saem em `notification_send_after`/`notification_max_wait`.
- **O que está amarrado a Conteúdo e ao portal**, e que um tipo que não seja de cliente do portal (por exemplo, um aviso a colaborador) precisa trocar numa migration nova: `client_id not null` e o gatilho `AFTER INSERT` de travar o cliente ativo; a regra de "ainda vale" e a lista de destinatários (vínculo ativo de `client_memberships`), que estão dentro do descarte da claim; e as colunas `content_*` do que a claim devolve, que obrigam `DROP` e `CREATE` da função e uma mudança no worker. O desenho de reuso fica como está: o segundo tipo decide se generaliza (regra de validade por tipo, retorno com dados por tipo) ou só acrescenta.
- Item que esgotou as tentativas fica na tabela, sem ser enviado nem descartado, para a operação ver.
- Preferências do destinatário e notificação dentro do produto continuam adiadas para o segundo tipo (seção 10 da SPEC).

**Origem.** Issue #252 e `specs/conteudo.md`, seções 8 e 9; forma de função de escopo único herdada de `archive_due_clients` (#133).

**Validação.** Pendente de validação do dono.
