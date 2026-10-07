# A sessão vale 7 dias sem uso, renova a cada 24 h de uso e tem teto absoluto de 30 dias

**Data.** 2026-10-07

**Contexto.** A SPEC (§4) dizia "renovada a cada 24h de uso, até o teto de 7 dias", e a §3 chamava o teto de "hook de banco". O código faz outra coisa, desde a primeira entrega: a sessão expira com **7 dias sem uso** (`expiresIn`, `better-auth.ts`), é renovada a cada **24 h** de uso (`updateAge`) e tem **teto absoluto de 30 dias** desde `createdAt` (`AUTH_SESSION_MAX_AGE_DAYS = 30`, `policy.ts`), imposto por `session-guard.ts` e pelo `databaseHooks.session.update.before` do Better Auth, que é JavaScript e não um gatilho do PostgreSQL. Os testes seguem o código (sessão de 31 dias recusada, renovação de uma sessão de 29 dias limitada a `createdAt + 30 dias`). Achado da auditoria de fechamento do módulo, issue #341.

**Decisão.** Opção (a): a SPEC passa a dizer **7 dias sem uso, renovada a cada 24 h de uso, teto absoluto de 30 dias**, e a §3 passa a chamar o teto de `databaseHooks` do Better Auth. É o padrão de mercado e não obriga quem usa o produto todo dia a entrar de novo toda semana; o teto de 30 dias continua limitando a sessão roubada. A opção (b), teto de 7 dias no código e nos testes, foi descartada: derrubaria a sessão de quem usa o produto diariamente a cada semana, em troca de uma janela de roubo menor que ninguém pediu.

**Consequência.** Só texto: SPEC, README do módulo e este registro. Nenhum código, teste, tabela, policy ou formato de resposta muda, e não há backfill. SPEC, código e testes dizem o mesmo número (30), e os testes o travam: desligar a conferência de `session-guard.ts`, remover o recorte do hook ou trocar a constante por 7, 29 ou 31 deixa a suíte de autenticação vermelha. Reabre quem quiser outro teto: é uma constante, o teste correspondente e a SPEC.

**Origem.** Issue #341, decisão do maestro com autonomia dada pelo dono do produto em 2026-10-07. **Pendente de validação** pelo dono do produto.

