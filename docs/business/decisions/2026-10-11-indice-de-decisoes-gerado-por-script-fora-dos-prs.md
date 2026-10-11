# Índice de decisões gerado por script, fora dos PRs de entrega

**Data.** 2026-10-11

**Contexto.** O dono pediu, em 2026-10-11, que o contexto dos agentes ficasse indexado. A decisão de 2026-10-07 (`2026-10-07-uma-decisao-por-arquivo`) disse que não há índice escrito à mão nem gerado: índice manual voltaria a ser um arquivo único em conflito, e índice gerado exigiria um commit de CI a cada decisão. Na revisão do PR #526, que trazia um índice escrito à mão e exigia uma linha nova em todo PR com decisão, a Lupa mostrou o conflito que a cláusula evitava: duas entregas que acrescentam decisão no fim do mesmo módulo tocam a mesma linha do índice.

**Decisão.** O índice `docs/business/decisions/README.md` é gerado pelo script `scripts/generate-decisions-index.mjs`, com o comando `pnpm docs:decisions-index`, a partir dos arquivos da pasta e do agrupamento por módulo que o próprio índice guarda. A regeneração não é obrigatória nos PRs de entrega: ela roda ao fim de cada onda, num PR de docs. Os PRs de entrega acrescentam só o arquivo da decisão nova, e não tocam o índice. O README avisa que pode estar atrasado até a próxima regeneração, e a fonte da verdade continua sendo a listagem da pasta.

Esta decisão substitui somente a cláusula "Não há índice escrito à mão nem gerado" de `2026-10-07-uma-decisao-por-arquivo`. O resto daquela decisão continua valendo, inclusive a regra de uma decisão por arquivo e o fato de `decisions.md` estar congelado.

**Consequência.** Nenhum PR de entrega toca o índice, então o conflito de linha no índice deixa de acontecer nesses PRs. O conflito fica concentrado no PR de regeneração, que é o único a tocar o índice, e se resolve regenerando o arquivo, não editando à mão. O índice pode ficar atrasado entre duas ondas, e quem procura uma decisão recente usa a listagem da pasta. Uma decisão nova que não cai em nenhum módulo aparece na seção "A classificar" até ser movida para o módulo certo na próxima regeneração.

**Origem.** Pedido do dono em 2026-10-11 de indexar o contexto dos agentes. Mecanismo decidido pelo maestro, em resposta à revisão da Lupa no PR #526.

**Validação.** Pendente de validação do dono.
