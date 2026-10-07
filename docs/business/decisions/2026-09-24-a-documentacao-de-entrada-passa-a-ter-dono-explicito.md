# A documentação de entrada passa a ter dono explícito
**Data.** 2026-09-24

**Contexto.** Antes de abrir o projeto para mais desenvolvedores, a documentação foi auditada contra a pergunta "o que falta para alguém começar sozinho?". Faltavam seis coisas, e a mais grave era estrutural: `pnpm cli:agency` é o **único** jeito de criar uma agência — logo, o único jeito de obter um ambiente utilizável — e estava mencionado uma única vez, dentro de uma entrada antiga de decisão. Um clone novo levava a um banco vazio sem caminho para frente.

**Decisão.** A documentação de entrada passa a ser composta por quatro peças, cada uma com um papel que as outras não têm:

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — branch, commit, PR, revisão, o que fazer quando o CI reprova.
- [`docs/local-environment.md`](local-environment.md) — do clone até um ambiente em que dá para entrar no produto, incluindo criar agência e ler o convite no Mailpit.
- [`docs/module-anatomy.md`](module-anatomy.md) — o molde que todo módulo da API segue, que o `AGENTS.md` afirmava existir sem descrever.
- [`docs/onboarding.md`](onboarding.md) — o roteiro de leitura, o processo de trabalho e as regras de sessão com agente.

Mais um template de pull request que cobra verificação real e a checagem estrutural.

**Consequência.** O roteiro de ambiente local foi **executado do início ao fim** antes de ser escrito, e isso revelou uma divergência que nenhuma leitura teria pego: o e-mail de convite aponta para `/invite/<token>` e o de recuperação para `/reset-password`, enquanto `specs/auth.md` decidiu rotas em português. Documentação de ambiente que não foi executada descreve o que deveria funcionar, não o que funciona.

**Origem.** Decidido em sessão.

