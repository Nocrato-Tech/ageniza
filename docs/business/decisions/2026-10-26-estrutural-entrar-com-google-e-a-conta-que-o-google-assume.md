# ESTRUTURAL: entrar com o Google, e quando o Google assume uma conta que já existe

**Data.** 2026-10-26

**Contexto.** `specs/auth.md` dizia que o login social "nunca entrou em pauta". O dono do produto quer dois jeitos de entrar: e-mail e senha, e Google. A identidade do produto é o e-mail (`auth."user".email` é único), e a decisão de 2026-09-24 diz que dois e-mails são duas contas e que identidades não se vinculam. Entrar com o Google no **mesmo** e-mail não vincula identidades, porque é a mesma identidade. O risco é outro: tomar uma conta que outra pessoa criou com o seu e-mail antes de você.

**Decisão.** O dono decidiu que existe **"Entrar com o Google"** em `/entrar`, em `/criar-conta` e na tela do convite.

1. Só vale o e-mail que o Google declara **verificado** (`email_verified`). Sem isso, o login é recusado com a mesma mensagem de credencial inválida.
2. **Não há conta com o e-mail**: o Google cria a conta já verificada, com o nome do Google. O aceite de Termos e Privacidade é pedido numa tela antes do primeiro uso, e sem ele não há contexto.
3. **Há conta com o e-mail, e o e-mail dela é verificado**: o Google passa a ser um segundo jeito de entrar na mesma conta. A senha continua valendo.
4. **Há conta com o e-mail, e o e-mail dela não foi confirmado**: o Google **assume** a conta. A senha é apagada, as sessões são encerradas, e o e-mail passa a verificado. Assim, quem criou uma conta com o e-mail de outra pessoa perde tudo no primeiro login do dono do e-mail. Os vínculos que a conta já tinha continuam.
5. Conta só com Google não tem senha. Os fluxos que pedem a senha atual (pedir troca de e-mail, regra 12 de `specs/auth.md`) passam a aceitar, para essa conta, a reautenticação recente pelo Google (no máximo 5 minutos). A impressão de credencial do pedido de troca de e-mail usa o identificador da conta Google no lugar do hash da senha. "Esqueci a senha" numa conta só com Google envia um link que **cria** a senha, pelo mesmo fluxo de redefinição.
6. Um token do Google nunca é guardado além do que o Better Auth exige para o login. O produto não pede escopo nenhum além de `openid email profile`.

**Consequência.** Estrutural: um provider novo em `auth."account"` e uma regra nova de quem é dono de uma conta (item 4). A troca de e-mail por pedido (decisão 2026-10-07) ganha um segundo tipo de credencial. Nenhuma tabela existente muda de forma e não há backfill. Pede credenciais OAuth do Google por ambiente (variáveis do servidor, nunca no frontend nem no repositório) e revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26. A existência do login com Google é do dono. Os itens 1 a 6 são as regras de segurança derivadas pelo maestro e estão **pendentes de validação pelo dono do produto**.
