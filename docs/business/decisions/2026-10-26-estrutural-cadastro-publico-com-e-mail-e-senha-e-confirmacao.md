# ESTRUTURAL: cadastro público com e-mail e senha, e confirmação do e-mail

**Data.** 2026-10-26

**Contexto.** Até aqui a conta só nascia de convite (`disableSignUp: true` no Better Auth), e por isso a verificação de e-mail estava "já satisfeita": o convite chegou naquele endereço (decisão 2026-09-24 sobre o escopo da autenticação, e 2026-09-15 sobre a entrada de agências). O dono do produto quer que uma pessoa entre sem precisar de convite: cria a conta, confirma o e-mail e usa o produto em trial até o upgrade (decisão do mesmo dia sobre a agência que nasce em trial).

**Decisão.** O dono decidiu que existe **cadastro público**.

1. `/criar-conta` pede nome, e-mail, senha (mínimo de 10 caracteres, a mesma regra do convite e da redefinição) e o aceite de Termos e Privacidade, gravando as duas versões em vigor, como o cadastro por convite.
2. A conta nasce com `emailVerified = false`, e um link de confirmação vai ao e-mail. **Sem confirmar, não há sessão.** Com a senha certa, o login de uma conta não confirmada diz "confirme o seu e-mail" e oferece reenvio: dizer isso não revela nada, porque a senha já foi provada. Com a senha errada, responde como qualquer credencial errada.
3. O link de confirmação é de uso único e vale 24 horas. Reenviar invalida o anterior. Confirmar marca o e-mail como verificado e leva a `/entrar`.
4. **Nada revela quais e-mails têm conta.** Criar conta com um e-mail que já tem conta responde exatamente como um cadastro novo ("enviamos um link para o seu e-mail"). Ao endereço vai um aviso "alguém tentou criar uma conta com este e-mail; se foi você, entre ou redefina a senha", e não um link de confirmação. O reenvio responde igual exista a conta ou não.
5. Limites de tentativa do mesmo tipo dos de login (por IP, por IP e e-mail, e por e-mail), para cadastro e para reenvio.
6. Depois de confirmada, a conta sem nenhum contexto **cria sessão** e vai a uma tela que oferece criar uma agência. Isso muda a regra 3 de `specs/auth.md` (credencial correta com zero contextos não cria sessão) só para contas com e-mail verificado.

**Consequência.** Estrutural: muda como a sessão é concedida (regra 3), monta rotas novas de autenticação e passa a usar `auth."verification"` para um segundo propósito. Não muda tabela existente nem exige backfill: as contas existentes já são verificadas. Substitui, nesta parte, as decisões de 2026-09-15 (agência só por comando interno) e de 2026-09-24 (escopo da autenticação, "cadastro público não existe" e "verificação já satisfeita"). Pede revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26. Itens 1 a 3: decididos pelo dono. Itens 4 a 6 são regras de segurança derivadas pelo maestro e estão **pendentes de validação pelo dono do produto**.
