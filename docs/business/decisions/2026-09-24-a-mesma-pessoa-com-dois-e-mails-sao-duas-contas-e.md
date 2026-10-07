# A mesma pessoa com dois e-mails são duas contas, e identidades não se vinculam
**Data.** 2026-09-24

**Contexto.** `auth."user".email` é único e o `User` é a identidade global. Perguntou-se o que acontece quando alguém é owner de uma agência com um endereço e colaborador de outra com endereço diferente.

**Decisão.** São **duas contas**, independentes, e isso é aceito. Vincular identidades — um login enxergando os contextos de todos os e-mails de uma pessoa — está **fora**: mudaria o que `User` significa, de identidade para agregado de identidades, atravessando RLS, `current_user_id()` e toda tabela que referencia usuário.

Com isso a regra de e-mail fecha por conta, não por papel: **se a conta é owner de alguma agência, o e-mail dela não é autosserviço**, porque amarra a assinatura que ainda não existe.

**Consequência.** "A mesma pessoa em vários lugares", como o `product-overview.md` descreve, vale apenas para contextos atrelados **ao mesmo e-mail** — convite é endereçado a um endereço, e o endereço define a conta. Quem tem duas contas precisa sair e entrar de novo para alternar: o seletor de contexto mostra somente os contextos daquela conta.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

