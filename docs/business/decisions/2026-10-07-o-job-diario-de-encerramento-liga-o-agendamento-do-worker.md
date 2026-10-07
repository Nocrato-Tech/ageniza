# O job diário de encerramento liga o agendamento do worker, e uma virada perdida não é reposta

**Data.** 2026-10-07

**Contexto.** `clients.archive-due` (#133) é o primeiro job agendado de negócio do sistema. O worker criava o pg-boss com `schedule: false`, então ninguém enviava jobs por cron: `boss.schedule()` gravava a linha em `pgboss.schedule` e nada a disparava. O papel da aplicação já tem acesso de dados a todo o schema `pgboss`, sem DDL, e a regra de quem pode arquivar está inteira em `app_private.archive_due_clients()`, a exceção documentada em `structural-changes.md` ("Trabalho agendado sem requisição").

**Decisão.**

1. O worker liga o monitor de cron do pg-boss (`schedule: true`). A API continua só enviando, com o agendamento desligado. Uma instância por vez vence cada passada do monitor, e o envio é deduplicado por nome e por minuto, então dois workers não duplicam o job.
2. Um job declara `schedule: { cron, timeZone }` na própria definição, e a fila o registra a cada inicialização por um *upsert* em `pgboss.schedule` (chave: o nome do job). Reiniciar o worker, ou subir dois, mantém uma linha só.
3. `clients.archive-due` roda todo dia às 00:10 em `America/Sao_Paulo` (`10 0 * * *`), registrado sempre que a fila existe. O job só chama `select app_private.archive_due_clients()` e registra no log quantos arquivou, sem cliente nem pessoa. Falha lança o erro e o pg-boss retenta com o recuo padrão.
4. Uma virada em que nenhum worker estava no ar não é reposta. O dia seguinte arquiva tudo o que já passou, porque a função arquiva `closing_date` anterior a hoje, não só a de ontem: o atraso é de um dia no pior caso, e rodar o job a cada inicialização para cobrir isso foi descartado por mudar o que a issue pede ("nada mais, o job é só o relógio").

**Consequência.** Não há migration nem *grant* novo para o job. Qualquer job futuro agendado, como a publicação agendada de Conteúdo, declara o `schedule` da mesma forma. O monitor de cron do worker lê `pgboss.schedule` inteira e envia o que estiver no horário, de qualquer fila: por isso o teste de integração usa um nome de fila próprio e o apaga ao final, e a linha de agendamento vai junto, sem tocar na fila real de quem roda o worker localmente. O ambiente local dispara o job à mão como `docs/local-environment.md` explica.

**Origem.** Issue #133 e a decisão estrutural "arquivar cliente é uma função `security definer` de escopo único, usada pelo job e pela rota" (`decisions.md`, 2026-09-26).

**Validação.** Pendente de validação do dono.
