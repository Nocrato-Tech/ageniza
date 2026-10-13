# Estrutural: o status da agência passa a ser derivado do estado comercial e da suspensão administrativa

**Data.** 2026-10-13

**Contexto.** Esta é uma mudança estrutural: altera a tabela `agencies`, que já existe, muda como o acesso de tenant é avaliado e precisa de backfill. Hoje `agencies.status = 'active'` é conferido em 88 pontos de 21 migrations (policies, funções e jobs). Fazer esses pontos lerem o estado comercial e a suspensão administrativa seria o retrofit mais caro do projeto.

**Decisão.** O `status` (`active`/`suspended`) continua sendo o único sinal de acesso que policies, funções e jobs leem, mas deixa de ser escrito à mão: uma função do banco o recalcula sempre que o estado comercial ou a suspensão administrativa mudam, cobrindo todas as transições da matriz, e um gatilho recusa qualquer escrita direta por outro caminho. A regra "acesso = estado comercial permite e não há suspensão administrativa" mora num lugar só.

Backfill: o produto não foi lançado, então não há legado. A migration grava a nossa agência como Isenta, com motivo explícito, e toda outra agência existente (teste e demonstração) como Isenta com o motivo "anterior à cobrança". A operação revê cada uma pelo comando. Toda isenção é explícita e auditável.

**Consequência.** Os 88 pontos não mudam. A migration é testada contra as policies, funções e jobs existentes (regressão das suítes de banco, API e worker), com plano de recuperação.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
