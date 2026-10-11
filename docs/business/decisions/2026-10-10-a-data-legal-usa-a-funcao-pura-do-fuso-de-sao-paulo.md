# A data legal usa a função pura do fuso de São Paulo, e nenhuma função escreve o fuso por conta própria

**Data.** 2026-10-10

**Contexto.** A decisão de 2026-10-07 (`2026-10-07-a-data-de-encerramento-do-cliente-vem-de-uma-funcao-pura-do-fuso.md`) criou `app_private.sao_paulo_date(timestamptz)` para o encerramento de contrato e deixou dito que a #373 podia reaproveitá-la. Duas funções ainda calculavam "hoje" inline, como `now() at time zone 'America/Sao_Paulo'`: `app_private.accept_legal_document` (a versão do aceite legal não pode estar no futuro) e `app_private.accept_invitation` (idem, para os termos aceitos junto com o convite). Entre 21h e 24h em Brasília a data de Brasília e a de UTC diferem, e nenhum teste ficava dentro dessa janela: a mutação `America/Sao_Paulo` para `UTC` continuava verde nas duas.

**Decisão.** As duas funções passam a perguntar `app_private.sao_paulo_date(pg_catalog.now())`, a definição única de "hoje" em Brasília. A migration troca só essa expressão, lendo a definição que está no banco (`create or replace` mantém dono e *grants*) e falhando se a expressão não aparecer exatamente uma vez. O teste de catálogo varre as funções, policies e constraints dos esquemas `public`, `app_private`, `audit` e `auth` e reprova qualquer uma, fora `sao_paulo_date`, que escreva `at time zone`, `current_date` ou `localtimestamp`: a próxima função que precisar de "hoje" tem de chamar a função pura, e uma nova que não o faça deixa o teste vermelho. O instante fixo às 22h de Brasília continua sendo testado em `sao_paulo_date`, a única que guarda o fuso.

`now()` continua `now()`, como na decisão de 2026-10-07: o relógio depois da espera pelo *lock* é outro achado e só erra no sentido seguro.

**Consequência.** Não muda tabela, coluna, policy, *grant* nem formato de resposta, e o comportamento das duas funções é o mesmo. O fuso por agência (#153) vira trocar o argumento de um lugar só. O que o teste não alcança é o `now()` real dentro das funções, que por isso é conferido pelo texto da definição.

**Origem.** Issue #373, achado Baixa 1 da revisão de segurança do PR #369 (Coruja), por instrução do maestro.

**Validação.** Pendente de validação do dono.
