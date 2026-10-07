# PR agrupado por tema e camada, até ~800 linhas

**Data.** 2026-10-07

**Contexto.** O `CONTRIBUTING.md` dizia "um PR, um assunto", e a revisão do PR #379 apontou a violação ao ver um PR que juntava duas tasks do mesmo tema. O dono decidiu em 2026-10-07 que PRs podem ser um pouco mais longos, juntando tasks que falam da mesma coisa, sem virar PR gigante.

**Decisão.**

1. Um PR pode juntar issues do **mesmo tema e da mesma camada**, cada uma com o seu `Closes #N` e o aceite item a item no corpo, até **~800 linhas de diff de código**. Acima disso, dividir. O agrupamento é por vizinhança: temas ou camadas diferentes continuam sendo PRs separados.
2. Continuam valendo sem exceção: **API e interface não vêm juntas**, e **migration não vem com código de API nem de tela**. Duas issues de banco do mesmo tema podem dividir a mesma migration.
3. O template de PR passa a aceitar mais de um `Closes`, um por issue agrupada.

**Consequência.** O número de PRs cai onde o assunto é o mesmo, e o revisor continua com uma revisão por camada; o teto de ~800 linhas é o freio, não o alvo. Nada muda no gate de decisão estrutural nem no fechamento de issue: `scripts/ci/closing-references.mjs` já lê todos os `Closes` do corpo.

**Origem.** Issue #380, pedido do dono em 2026-10-07.

**Validação.** Pendente de validação do dono.
