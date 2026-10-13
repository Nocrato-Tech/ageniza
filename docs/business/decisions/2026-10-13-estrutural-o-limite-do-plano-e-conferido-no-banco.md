# Estrutural: o limite do plano é conferido no banco, com trava

**Data.** 2026-10-13

**Contexto.** Esta é uma mudança estrutural: toca funções e policies de Clientes, Colaboradores e Mídia. A regra 5 exige que duas requisições simultâneas nunca usem a mesma vaga, e só o banco, com trava, garante isso.

**Decisão.** O limite é conferido no banco, por uma função que trava a agência, conta e reserva ou insere na mesma transação. Ela é chamada pelas funções de criar cliente, reativar cliente, criar convite e reservar upload. É o mesmo modelo da cota de mídia que já existe (`agency_media_usage`). Na mídia, uma nova tentativa do mesmo upload nunca reserva a cota duas vezes. A API só traduz a recusa na mensagem de limite.

**Consequência.** Os testes de limite são de concorrência real, com duas transações disputando a última vaga.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
