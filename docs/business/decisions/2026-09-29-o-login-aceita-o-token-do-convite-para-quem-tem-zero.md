# O login aceita o token do convite para quem tem zero contextos

**Data.** 2026-09-29

**Contexto.** A entrada de 2026-09-24 ("Credencial correta sem nenhum contexto não cria sessão") diz que a conta continua existindo depois de perder todo contexto, e que "um convite novo para o mesmo e-mail volta a funcionar pelo fluxo de conta existente — não é exclusão, é acesso sem vínculo". Esse fluxo (`POST /invitations/:token/accept`, estado "já tem conta" da tela de convite) exige sessão via `requireSession`, e essa sessão só existe hoje se `POST /auth/login` a criar antes — exatamente o que a mesma entrada de 2026-09-24 passou a negar para quem tem zero contextos. O furo foi encontrado na implementação da issue #68 (PR #164): sem um mecanismo à parte, a própria decisão de 2026-09-24 se contradiz para quem foi removido de tudo e reconvidado.

**Decisão.** `POST /auth/login` aceita um campo opcional `inviteToken`. Quando a credencial é correta e a conta tem zero contextos, a sessão é criada **somente se** `inviteToken` corresponder a um convite **válido** — não usado, não revogado, não expirado (relógio do banco), endereçado ao **mesmo e-mail** da conta (comparação já normalizada, como o resto do código), de agência ativa e, se for convite de cliente, de cliente ativo — usando a mesma checagem de validade que o módulo de convites já usa (`app_private.invitation_by_token_hash`), nunca duplicada. Caso contrário, a resposta é o `403 NO_CONTEXT_ACCESS` de sempre. Um token ausente, inválido, de e-mail diferente, expirado, revogado ou de agência/cliente inativo produz **exatamente a mesma resposta**, byte a byte: `inviteToken` nunca serve para descobrir se um convite ou uma conta existe.

A sessão criada assim continua **sem contexto** até o convite ser de fato aceito. `GET /me/contexts/resolve` continua encerrando qualquer sessão sem contexto na sua própria passagem (2026-09-24), então a tela de convite (issue #76) precisa chamar `POST /invitations/:token/accept` **antes** de qualquer chamada a `resolve` — chamar `resolve` primeiro encerraria a sessão sem dar chance ao aceite.

**Consequência.** O caso que a entrada de 2026-09-24 já previa ("convite novo volta a funcionar pelo fluxo de conta existente") passa a ter um caminho de fato executável. O custo é a tela de convite ter que conhecer essa ordem (`login` com token → `accept` → só então `resolve`), documentada no README do módulo `auth`. Nenhuma migration; nenhum formato de resposta muda, só um campo opcional a mais no corpo de `POST /auth/login`.

**Origem.** Decidido em sessão (orquestração), a partir do achado registrado no PR #164. **Pendente de validação.**

