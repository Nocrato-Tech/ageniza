# A regra de mudança estrutural é um gate de CI, não uma recomendação

**Data.** 2026-09-23

**Contexto.** `structural-changes.md` pedia que uma mudança estrutural fosse registrada antes de ser implementada, mas era só instrução: nada impedia agente ou pessoa de seguir adiante. Rodando a verificação contra o histórico, as PRs #40 e #41 teriam sido barradas — as duas alteraram tabelas existentes e revogaram privilégios sem registrar a decisão, e foi revisão manual que pegou.

**Decisão.** `scripts/ci/verify-structural-decisions.mjs` roda no job de migration e falha quando uma migration da mudança contém SQL que alcança algo já implantado — `alter table` sobre tabela que ela não criou, `drop policy`, `drop table`, `drop column`, `revoke` ou `drop function` — sem que `docs/business/decisions.md` tenha sido tocado na mesma mudança.

**Consequência.** Migration que apenas cria objetos novos passa sem atrito, inclusive o `alter table` que a própria migration usa para habilitar RLS na tabela que acabou de criar. Falso positivo se resolve registrando a entrada e dizendo que não era decisão: custa um parágrafo, contra um retrofit. O gate cobre o banco, que é onde mudar de ideia é mais caro; mudança estrutural só de API ainda depende da revisão.

**Origem.** Decidido em sessão.

