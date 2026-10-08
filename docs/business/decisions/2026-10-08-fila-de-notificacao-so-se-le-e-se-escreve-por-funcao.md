# A fila de notificação só se lê e só se escreve por função

**Data.** 2026-10-08

**Esta é uma mudança estrutural.** É o primeiro mecanismo de notificação do produto, e o formato que os próximos tipos vão copiar (ponto 7 de `2026-10-01-conteudo-impacto-estrutural.md`). Acrescenta um gatilho à tabela `contents`, que já existe, e uma tabela que guarda e-mail de pessoas.

**Contexto.** A SPEC de Conteúdo (seções 8 e 9) pede um e-mail ao cliente, enviado pelo worker, para todas as pessoas ativas do portal, e diz que o desenho é uma fila: destinatário, tipo, cliente, referência e janela de agrupamento. O worker conecta como `ageniza_app`, sem usuário, e não pode ter acesso amplo (`structural-changes.md`, "Trabalho agendado sem requisição"). Uma fila com policy teria de deixar o worker ler o e-mail de pessoas que ele não conhece, e uma fila que a rota alimenta deixaria o corpo de uma requisição decidir quem recebe e-mail.

**Decisão.**
1. **`notification_queue` não tem privilégio algum para `ageniza_app`, tem RLS forçada e nenhuma policy.** Duas travas que negam sozinhas: um `grant` futuro continua mostrando zero linhas. Estado (`claimed_at`, `attempts`, `last_error`, `sent_at`, `discarded_at`) só muda pelas funções.
2. **Quem enfileira é o banco.** Um gatilho `AFTER UPDATE` em `contents`, `security definer`, dispara quando o conteúdo **passa** a "aguardando aprovação" (inclusive quando o próprio banco o devolve para lá porque a legenda mudou, regra 6) ou a "publicado". Nenhuma função que enfileira é concedida, e nenhuma rota escreve na fila. O gatilho não usa `UPDATE OF status`: gatilho com lista de colunas ignora a coluna que outro gatilho `BEFORE` altera.
3. **Destinatário é o vínculo ativo do portal** daquele cliente (`client_memberships`), nunca um `auth."user"` solto. Cliente arquivado e agência suspensa não geram item (regra 8). O gatilho toma o cliente `FOR SHARE`, como todo escritor dele, e a fila tem o gatilho `AFTER INSERT` de travar cliente ativo (A0020) das filhas do cliente.
4. **O worker lê e marca por três funções** (`claim_notification_batch`, `mark_notifications_sent`, `fail_notifications`), concedidas a `ageniza_app`. Como o worker é `ageniza_app`, as funções **recusam (42501) quem tem ator ligado à transação**: toda requisição da API liga um ator, o worker nunca liga, então a lista de endereços não é algo que uma requisição consiga pedir. Recusam também qualquer isolamento diferente de READ COMMITTED (40001), porque travam e releem.
5. **A claim devolve o que o e-mail precisa** (endereço, nome do cliente e da agência, título e data do conteúdo), porque o worker não lê mais nada. Cada item reivindicado vale um arrendamento de 10 minutos; depois disso outra claim pode pegá-lo, e um item é tentado no máximo 5 vezes.
6. **O erro de uma falha é um código curto** (`^[a-z0-9_.:-]{1,64}$`), nunca o texto do provedor, que carrega o endereço do destinatário.

**Consequência.**
- A #260 (worker) chama as três funções sem ligar ator, e `mark_notifications_sent`/`fail_notifications` só valem para o que a claim entregou.
- Os próximos tipos de notificação acrescentam o tipo e a coluna de referência na tabela, a regra de "ainda vale" na claim e a regra de quando saem em `notification_send_after`/`notification_max_wait`.
- Item que esgotou as tentativas fica na tabela, sem ser enviado nem descartado, para a operação ver.
- Preferências do destinatário e notificação dentro do produto continuam adiadas para o segundo tipo (seção 10 da SPEC).

**Origem.** Issue #252 e `specs/conteudo.md`, seções 8 e 9; forma de função de escopo único herdada de `archive_due_clients` (#133).

**Validação.** Pendente de validação do dono.
