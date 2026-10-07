# O convite é aceito automaticamente depois do login pelo link, só para o e-mail do convite
**Data.** 2026-10-07

**Contexto.** Quem recebia um convite para uma conta que já existia clicava em "Aceitar convite", era levado ao login com o token, entrava e precisava clicar de novo em "Aceitar convite" na volta. A #184 deixou o comportamento automático em aberto; a decisão de produto veio em 2026-10-07.

**Decisão.** Depois do login, o aceite acontece **sem novo clique** apenas quando as duas condições valem: a pessoa chegou ao login pelo link do convite (o token viajou no `state` da navegação até o login) e o e-mail da conta autenticada é o mesmo do convite. Nesse caso a tela do convite aceita sozinha e a pessoa cai na agência ou no portal **do convite**. Se o e-mail for diferente, **nada é aceito**: a tela do convite explica que o convite foi enviado para outro endereço e oferece sair e entrar com a conta certa. Convite vencido ou revogado continua com o mesmo `INVALID_LINK`, sem revelar qual dos casos ocorreu.

**Consequência.** Nenhuma rota muda. O marcador do login vive só no `state` da navegação, como o destino da sessão, nunca na URL — que carregaria o token no histórico e no referer. O destino é o contexto que a própria resposta do aceite carrega (`{ agencyId, clientId }`), nunca o que a sessão resolveria: sem isso, quem tem vínculo em mais de uma agência aceitava o convite de uma e caía na área de outra, com o aviso nomeando a agência errada (achado da revisão de segurança do PR #317). A comparação de e-mail acontece na tela, entre a sessão e o preview, e o `403 INVITATION_ACCOUNT_MISMATCH` da API continua como segunda barreira no aceite manual. O aceite automático não vale para quem abre o link já com sessão, nem para o `signedIn` da redefinição de senha, que continuam exigindo o clique.

**Origem.** Issue #184, decidida pelo maestro com autonomia dada pelo dono em 2026-10-07. **Pendente de validação** pelo dono do produto.

