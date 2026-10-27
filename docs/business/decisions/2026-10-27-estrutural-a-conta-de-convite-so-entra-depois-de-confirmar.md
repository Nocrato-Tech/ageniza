# ESTRUTURAL: a conta de convite só entra no produto depois de confirmar o e-mail

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 sobre o link copiável do convite abriu uma exceção a "sem confirmar, não há sessão": a conta criada pelo aceite do token copiado nasce não confirmada e já usa a agência do convite com a sessão do aceite. As decisões de 2026-10-27 `token-de-confirmacao-com-estado-e-sessao-da-conta-de-convite` (item 3) e `o-aceite-pelo-link-do-e-mail-confirma-o-e-mail` (item 3) mantiveram essa exceção: a sessão do aceite abre os contextos, e a confirmação vem depois. O dono do produto quer o contrário: nenhuma conta não confirmada acessa o produto, nem a que veio de um convite. Só depois de confirmar o e-mail.

**Decisão.**

1. **A conta não confirmada não abre contexto nenhum.** Isso vale para toda conta não confirmada, inclusive a criada pelo aceite do token copiado. O aceite continua criando a conta, consumindo o convite e mandando o e-mail de confirmação. A sessão que sobra, a do aceite, existe só para a pessoa ver que falta confirmar e para o clique de confirmação (item 2): `GET /me/contexts` responde a lista vazia, `GET /me/contexts/resolve` responde `none`, e toda outra rota autenticada, inclusive as de agência e de cliente, responde `403 EMAIL_NOT_CONFIRMED`. A tela mostra "confirme seu e-mail para entrar".
2. **O clique no e-mail de confirmação, com essa sessão, confirma sem pedir a senha**, como já faz hoje (`POST /auth/email/verify` sem senha, só com a sessão da própria conta). Depois de confirmar, a pessoa entra direto na agência do convite. Sem a sessão, por exemplo em outro navegador, vale a confirmação normal, com a senha.
3. **O aceite pelo token do e-mail não muda**: a conta nasce confirmada e a pessoa entra direto.
4. **O login por senha da conta não confirmada continua `401 INVALID_CREDENTIALS` para todos**, sem distinguir conta com convite: o oráculo de existência de conta do #722 não volta.
5. **O convite de portal antigo** segue a mesma regra. Se ainda criar conta não confirmada com sessão, essa conta também não abre contexto até confirmar.

**Isso substitui**, nas decisões de 2026-10-27 acima, a parte que deixava a sessão da conta de convite abrir a agência: o item 3 de `token-de-confirmacao-com-estado-e-sessao-da-conta-de-convite` (o que a sessão ainda fazia, e não o que a mantém viva) e o item 3 de `o-aceite-pelo-link-do-e-mail-confirma-o-e-mail` (o que a conta do link copiado faz com a sessão). Essas decisões não são editadas. Continua valendo o que as duas dizem sobre quando a sessão da conta de convite vive (enquanto ela mantém o vínculo que o convite deu e esse contexto seria listado) e sobre a confirmação por clique, que exige a sessão da própria conta.

**Consequência.** Estrutural: muda como a autorização é avaliada. O guarda de sessão passa a recusar, por padrão, a sessão de conta não confirmada em toda rota que não a aceite de forma explícita (a sessão, o encerramento dela e os dois contextos); os guardas de agência e de cliente e a lista de contextos consultam o banco (`app_private.email_not_confirmed`, migration `20261027130000`) e recusam ou devolvem vazio, de modo que cada camada vale sozinha. `GET /auth/session` e `GET /auth/session/check` ganham `emailVerified` para a tela saber em que estado a conta está. Nenhuma política de RLS muda, e não há backfill: as contas existentes ou já são confirmadas ou não têm sessão. Pede revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-27: nenhuma conta não confirmada acessa o produto, nem pelo convite.

**Validação.** Validada pelo dono em 2026-10-27.
