# ESTRUTURAL: entrar com o Google, e quando o Google assume uma conta que já existe

**Data.** 2026-10-26

**Contexto.** `specs/auth.md` dizia que o login social "nunca entrou em pauta". O dono do produto quer dois jeitos de entrar: e-mail e senha, e Google. A identidade do produto é o e-mail (`auth."user".email` é único), e a decisão de 2026-09-24 diz que dois e-mails são duas contas e que identidades não se vinculam. Entrar com o Google no **mesmo** e-mail não vincula identidades, porque é a mesma identidade. O risco é outro: tomar uma conta que outra pessoa criou com o seu e-mail antes de você.

**Decisão.** O dono decidiu que existe **"Entrar com o Google"** em `/entrar`, em `/criar-conta` e na tela do convite.

1. Só vale o e-mail que o Google declara **verificado** (`email_verified`). Sem isso, o login é recusado com a mesma mensagem de credencial inválida.
2. **Não há conta com o e-mail**: o Google cria a conta já verificada, com o nome do Google. O aceite de Termos e Privacidade é pedido numa tela antes do primeiro uso, e sem ele não há contexto.
3. **Há conta com o e-mail, e o e-mail dela é verificado**: o Google passa a ser um segundo jeito de entrar na mesma conta. A senha continua valendo. Esse vínculo automático depende de configurar o `accountLinking` do Better Auth **só para o Google** e **só com `email_verified`**. Nenhum outro provider vincula sozinho.
4. **Há conta com o e-mail, e o e-mail dela não foi confirmado**: o Google **assume** a conta, e o e-mail passa a verificado. Morre, na mesma transação:
   - a senha;
   - todas as sessões, invalidadas **pela data da troca**, para que um login com a senha antiga em andamento não sobreviva;
   - os links de redefinição de senha pendentes;
   - as confirmações de e-mail pendentes;
   - os pedidos de troca de e-mail abertos (`superseded`, como na regra 18 de `specs/auth.md`), porque a conta não confirmada criada pelo convite tem sessão e pode pedir a troca;
   - o aceite de Termos e Privacidade gravado antes. O registro fica, para auditoria, marcado como revogado (`revoked_at`), e o aceite é pedido de novo ao dono do e-mail antes do primeiro uso, como no item 2. O novo aceite da mesma versão grava uma linha nova.

   Os vínculos que a conta já tinha continuam. Os links de aprovação não mudam, porque pertencem ao acesso ao portal dado ao e-mail e não à conta (decisão do mesmo dia sobre o acesso ao portal). Assim, quem criou uma conta com o e-mail de outra pessoa perde tudo no primeiro login do dono do e-mail. "Esqueci a senha" numa conta não confirmada tem o mesmo efeito (decisão do mesmo dia sobre o cadastro, item 5).
5. **A conta Google é identificada pelo `sub`**, e não pelo e-mail, depois do primeiro vínculo (`auth."account".accountId`). Se o e-mail que o Google declara não for mais o da conta vinculada àquele `sub`, ou se o `sub` estiver vinculado a outra conta que não a do e-mail, o login é recusado com a mesma mensagem de credencial inválida.
6. Conta só com Google não tem senha. Os fluxos que pedem a senha atual (pedir troca de e-mail, regra 12 de `specs/auth.md`) passam a aceitar, para essa conta, a reautenticação recente pelo Google (no máximo 5 minutos). A impressão de credencial do pedido de troca de e-mail (regra 18) usa o `sub` da conta Google no lugar do hash da senha. "Esqueci a senha" numa conta só com Google envia um link que **cria** a senha, pelo mesmo fluxo de redefinição.
7. Um token do Google nunca é guardado além do que o Better Auth exige para o login. O produto não pede escopo nenhum além de `openid email profile`.

**Consequência.** Estrutural: um provider novo em `auth."account"` e uma regra nova de quem é dono de uma conta (item 4). A troca de e-mail por pedido (decisão 2026-10-07) ganha um segundo tipo de credencial, o que muda as regras 12 e 18 de `specs/auth.md`. O aceite jurídico ganha um caso em que deixa de valer, e isso **altera `legal_acceptances`**: hoje ela tem `unique (user_id, document, version)` e a gravação usa `on conflict ... do nothing`, então o novo aceite da mesma versão não gravaria nada e o aceite de quem criou a conta seria o único registro. A tabela ganha `revoked_at`, o único passa a valer só entre os não revogados (índice único parcial `where revoked_at is null`), e `app_private.accept_legal_document` passa a conferir só os não revogados. Isso muda a regra 7a de `specs/auth.md`. As linhas existentes ficam com `revoked_at` nulo, sem backfill. As demais tabelas não mudam de forma. Pede credenciais OAuth do Google por ambiente (variáveis do servidor, nunca no frontend nem no repositório) e revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26. A existência do login com Google é do dono. Os itens 1 a 7 são as regras de segurança derivadas pelo maestro, e a lista do item 4, o `accountLinking` do item 3 e o item 5 vieram da revisão do PR #720.

**Validação.** Validada pelo dono em 2026-10-27.
