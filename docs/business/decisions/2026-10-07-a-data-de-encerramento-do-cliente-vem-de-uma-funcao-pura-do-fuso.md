# A data de encerramento do cliente vem de uma função pura do fuso, e rota e job a chamam

**Data.** 2026-10-07

**Contexto.** "Hoje", para um contrato, é o dia em `America/Sao_Paulo` (`specs/clientes.md` seção 4, e o fuso por agência está adiado na #153). `app_private.set_client_closing_date` (rotas de agendar) e `app_private.archive_due_clients` (o job) escreviam a expressão inline, `now() at time zone 'America/Sao_Paulo'`. Entre 21h e 24h em Brasília a data de Brasília e a de UTC diferem, e nenhum teste fica de pé dentro dessa janela: a mutação `America/Sao_Paulo` para `UTC` continuava verde, o mesmo achado que a #373 registra para a data legal. Como `now()` não se fixa num teste, o que se pode fixar é uma função do instante.

**Decisão.** Uma função pura nova, `app_private.sao_paulo_date(timestamptz)`, devolve o dia de Brasília de um instante. As duas funções passam a perguntar a ela (`app_private.sao_paulo_date(pg_catalog.now())`) e deixam de ter fuso próprio, então rota e job não têm dois relógios. A migration substitui as duas funções com `create or replace`, o que mantém dono e *grants*, e só a linha que calcula "hoje" muda. A função pura é concedida a `ageniza_app` e negada ao `PUBLIC`: não lê linha nem guarda dado, e Conteúdo (policies e funções de publicação agendada) precisa chamá-la. É a definição única de "hoje" em Brasília; quem precisar dela a chama em vez de criar outra. O parâmetro se chama `p_instant`. O teste chama a função pura com instante fixo às 22h de Brasília (01h UTC do dia seguinte) e na virada, 03h UTC, e confere que as duas funções a usam e não citam fuso.

`now()` continua `now()` de propósito: ler o relógio depois da espera pelo *lock* é outro achado (comentário do Ponte na #373) e só erra no sentido de arquivar menos.

**Consequência.** A #373 pode reaproveitar `sao_paulo_date` para a data legal em vez de criar uma segunda função. Não muda tabela, coluna, policy, *grant* nem formato de resposta; o comportamento das duas funções é o mesmo. O fuso por agência (#153) vira trocar o argumento de um lugar só. O que o teste não alcança é o `now()` real dentro das duas funções, que por isso é conferido pelo texto da definição.

**Origem.** Issues #131 e #133, por instrução do maestro (usar instante fixo nos testes, lição da #373).

**Validação.** Pendente de validação do dono.
