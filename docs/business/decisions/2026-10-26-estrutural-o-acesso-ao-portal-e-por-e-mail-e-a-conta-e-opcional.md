# ESTRUTURAL: o acesso ao portal é dado a um e-mail, e a conta é opcional

**Data.** 2026-10-26

**Contexto.** A pessoa do portal só existe depois de aceitar o convite e criar conta (`client_memberships` aponta para um usuário). Quem só quer aprovar um post precisava criar senha e entrar, e é aí que o cliente desiste (análise de mercado trazida pelo dono em 2026-10-26). O dono quer duas saídas: o link de aprovação sem login (decisão do mesmo dia) e uma conta, para quem quer ver o portal inteiro.

**Decisão.** O dono decidiu que criar conta é livre, mas **ver um portal depende sempre do vínculo que a agência deu**.

1. Na aba Acessos, **Convidar** passa a ser **Adicionar pessoa**, só com o e-mail. A pessoa ganha o acesso ao portal daquele cliente **na hora**, sem conta, e recebe um e-mail de boas-vindas com "Entrar no portal" (criar conta ou entrar).
2. Com acesso e sem conta, a pessoa recebe os e-mails de aprovação e aprova pelo link (decisão do mesmo dia). Não vê o portal.
3. Quando uma conta com **aquele e-mail verificado** entra, por senha ou pelo Google, o acesso passa a ser dela e o portal aparece nos contextos. Conta com o e-mail não confirmado não ganha o portal até confirmar.
4. Uma conta nova sem acesso a nenhum portal nem agência não vê portal nenhum: só a opção de criar agência (decisão do mesmo dia sobre o trial).
5. Remover o acesso continua encerrando as sessões da pessoa, e passa a invalidar também os links de aprovação dela.
6. O convite de portal com token deixa de ser criado. Os convites de portal pendentes continuam aceitáveis até vencer.

**Consequência.** Estrutural: `client_memberships` passa a aceitar um acesso por e-mail sem usuário, e o vínculo ao usuário acontece por e-mail verificado. Toda policy que lê `client_memberships` pelo usuário continua igual, porque um acesso sem usuário nunca casa com o ator. Não há backfill, porque todo acesso existente já tem usuário. Muda a tela de Acessos e as rotas de convite de portal. Pede revisão de segurança independente: o vínculo por e-mail não pode valer para um e-mail que a conta não provou.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26 ("Só pelo vínculo da agência"). A regra de vínculo é do dono. O mecanismo (itens 1, 5 e 6) foi proposto pelo maestro e está **pendente de validação pelo dono do produto**.
