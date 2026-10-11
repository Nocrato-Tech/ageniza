# O catálogo reprova o dia calculado por conta própria por forma, e o `now()` real é provado por comportamento

**Data.** 2026-10-11

**Contexto.** A decisão de 2026-10-10 (`2026-10-10-a-data-legal-usa-a-funcao-pura-do-fuso-de-sao-paulo.md`) já foi mergeada e não se edita. Duas frases dela ficaram desatualizadas. Ela diz que o teste de catálogo varre as funções, policies e constraints e "reprova qualquer uma, fora `sao_paulo_date`, que escreva `at time zone`, `current_date` ou `localtimestamp`", e que "o que o teste não alcança é o `now()` real dentro das funções, que por isso é conferido pelo texto da definição". A revisão do PR #506 (Lupa, #499) mostrou as duas coisas: o scan do PR já era mais largo do que a decisão dizia, mas deixava passar formas equivalentes e acusava usos que não calculam o dia; e o `now()` real passou a ser provado por comportamento, não só pelo texto. A issue #509 (itens 4 e 6) pediu o scan sem falso positivo e uma decisão que atualize a de 2026-10-10.

**Decisão.** Esta decisão atualiza a de 2026-10-10 nos dois pontos. O resto dela segue valendo: `app_private.sao_paulo_date(timestamptz)` é a definição única de "hoje" em Brasília, e `accept_legal_document` e `accept_invitation` perguntam a ela o dia com `pg_catalog.now()`.

1. **O que o catálogo reprova.** O teste de `packages/database/test/client-dates.integration.test.ts` lê, nos esquemas `public`, `app_private`, `audit` e `auth`, as funções e as *procedures* (menos `sao_paulo_date`), as *views* e *views* materializadas, o `WHEN` de cada trigger, as policies, as constraints e os *defaults* de coluna, e reprova o que calcula o dia ou o fuso por conta própria. A leitura é por forma (`packages/database/test/support/own-day-scan.ts`): tira comentários e o conteúdo de strings, apaga as chamadas de `sao_paulo_date(...)` e acusa:
   - `current_date`, `current_time`, `localtime`, `localtimestamp` e `at time zone`, onde estiverem;
   - o relógio (`now()`, `clock_timestamp()`, `statement_timestamp()`, `transaction_timestamp()`, `current_timestamp` ou os literais `'now'`, `'today'`, `'tomorrow'`, `'yesterday'`) convertido para `date`, `timestamp` sem fuso, `time` ou texto, por `::`, por `cast(... as ...)`, por uma cadeia de casts ou depois de aritmética (`(now() - interval '3 hours')::date`);
   - o relógio passado a `date`, `date_trunc`, `date_bin`, `to_char`, `extract` ou `date_part`, em qualquer campo menos `epoch` e os segundos e suas frações;
   - `timezone(...)` aplicado a qualquer coisa que não seja só literal.

   Não acusa o relógio usado como instante (`now()`, `now() + interval '30 minutes'`), a idade em segundos (`extract(epoch from ...)`), `date_trunc` ou `timezone` de constantes, nem o dia que vem de `sao_paulo_date(now())`.
2. **O scan é por forma e não prova ausência.** Uma forma que ninguém escreveu como sonda pode passar. Por isso cada forma que ele conhece tem uma sonda, num teste sem banco (`own-day-scan.test.ts`) e no catálogo, e uma forma nova achada em revisão ganha a sonda no mesmo PR que a ensina ao scan. Não existe lista de exceções por nome: uma função legítima que o scan acuse deve ser reescrita para perguntar a `sao_paulo_date`, ou o scan deve aprender a forma nova com a sonda dela.
3. **O `now()` real é provado por comportamento.** O teste `what accept_legal_document and accept_invitation do with the day sao_paulo_date answers` troca `sao_paulo_date` por um substituto que responde um dia fixo (2020-06-15) e guarda o instante que recebeu, dentro de uma transação desfeita. `askedWithTheClock` confere que o instante recebido é o `now()` da transação, e o dia fixo, longe do presente, faz vermelhar qualquer função que calcule "hoje" por outro caminho. O texto da definição continua conferido (`pg_get_functiondef` contém `app_private.sao_paulo_date(pg_catalog.now())`), mas já não é a única barreira.

**Consequência.**

- A decisão de 2026-10-10 fica como registro do que se decidiu naquele dia; onde ela diverge desta, vale esta.
- Nenhuma migration, tabela, *grant*, policy ou formato de resposta muda.
- A próxima função, *procedure*, *view* ou trigger que precisar de "hoje" tem de chamar `app_private.sao_paulo_date`; uma que escreva o fuso por conta própria, mesmo pelas formas equivalentes de (1), deixa o teste vermelho.
- O que o scan não alcança (uma forma sem sonda, ou uma conversão que ele não segue, como a de um valor guardado em coluna) é achado de revisão, não de máquina.

**Origem.** Issue #509 (itens 4 e 6), sugestões da revisão do Lupa no PR #506 (#499). O scan descrito em (1) é o do PR #514.

**Validação.** Pendente de validação do dono.
