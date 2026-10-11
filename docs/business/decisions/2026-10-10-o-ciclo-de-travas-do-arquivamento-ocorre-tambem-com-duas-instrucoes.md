# O ciclo de travas do arquivamento ocorre também com duas instruções

**Data.** 2026-10-10

**Contexto.** A decisão de 2026-10-07 (`2026-10-07-arquivar-o-cliente-cancela-o-conteudo-e-trava-as-filhas.md`), na lista de consequências, afirma que o ciclo de travas entre um escritor que já segura a linha de um conteúdo e o arquivamento "só é alcançável dentro da janela de uma única instrução". A revisão de segurança do PR #393 provou o contrário por execução: um `UPDATE` do conteúdo seguido de um `INSERT` de subtarefa, na mesma transação, também forma o ciclo (a transação segura o conteúdo pelo `UPDATE`, e o `INSERT` da subtarefa dispara a trava `FOR SHARE` do cliente, que o arquivamento já segura enquanto espera o conteúdo). A afirmação estava errada, e o job que se apoiava nela repetia a execução inteira quando perdia o ciclo, desfazendo o lote da hora.

**Decisão.** O texto certo é: o ciclo de travas pode ocorrer **em qualquer transação que segure uma linha de conteúdo e depois peça o cliente**, em uma instrução ou em várias; o PostgreSQL o desfaz com `40P01`, que a aplicação já trata como conflito repetível. A rota de arquivar responde 409 `TRY_AGAIN` (`tryAgain()` em `lifecycle-routes.ts`) e quem chamou repete. O job do arquivamento passa a tratá-lo cliente a cliente, conforme `2026-10-10-os-gatilhos-pulam-pelo-atributo-do-papel-e-o-job-de-arquivamento-vai-cliente-a-cliente.md`, para que um ciclo perdido não desfaça o lote. A decisão de 2026-10-07 não é editada: este arquivo a corrige, e vale o que ele diz onde os dois divergirem.

**Consequência.** Nenhuma mudança de código além da citada na decisão acima. Quem ler a decisão de 2026-10-07 e precisar saber quando o 40P01 ocorre encontra aqui o texto correto.

**Origem.** Issue #397, ressalva 2 da revisão de segurança do PR #393 (Coruja); decisão do dono em 2026-10-10.

**Validação.** Validada pelo dono em 2026-10-10.
