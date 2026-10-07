# Até o lançamento do MVP, sem rodada de QA nem teste de invasão
**Data.** 2026-10-06

**Contexto.** Além da revisão de cada PR, o fluxo vinha incluindo rodadas de QA manual e testes de invasão sobre o que já estava integrado. Isso atrasa a entrega, e o foco agora é lançar o MVP o quanto antes.

**Decisão.** Até o lançamento do MVP, o fluxo é implementar, revisar e integrar. Todo PR continua passando pela revisão de código e, quando toca o que `AGENTS.md` lista, pela revisão de segurança de [`docs/security-review.md`](../security-review.md), que segue igual: ataques executados contra o que o próprio PR entrega. Ficam suspensos as rodadas de QA manual, os testes de integridade e os testes de invasão fora do escopo de um PR. O dono do produto faz essa validação no fim do MVP, antes do lançamento.

**Consequência.** Uma issue é dada como pronta quando o PR passa no CI e nas revisões, sem esperar uma rodada de QA. Bugs e brechas achados na validação final viram issues, priorizadas nesse momento.

**Origem.** Decidido pelo dono do produto em sessão, em 2026-10-06.

