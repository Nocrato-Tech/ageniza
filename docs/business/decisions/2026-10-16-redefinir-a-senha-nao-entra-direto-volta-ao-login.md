# Redefinir a senha não entra direto: volta ao login

**Data.** 2026-10-16

**Contexto.** A decisão de 2026-09-29, "O reset de senha sempre autentica, exceto sem nenhum contexto" (issue #175, com a correção da revisão de segurança do PR #176), fez `POST /auth/password/reset` assinar a pessoa de volta com a senha nova: `200 { signedIn: true }` com cookie, ou `200 { signedIn: false, reason }` com `NO_CONTEXT_ACCESS` (zero contextos confirmados) ou `SIGN_IN_REQUIRED` (qualquer outra falha em criar a sessão). Em teste manual, em 2026-10-16, o dono viu a pessoa cair dentro da área logo depois de trocar a senha e decidiu que não é isso que espera.

**Decisão.**
- Redefinir a senha **troca a senha, encerra todas as sessões da conta e não cria sessão**. A rota responde sempre `204`, sem corpo e sem cookie, tenha a conta contexto ou não; o `400 INVALID_LINK` de link inválido, usado ou vencido não muda.
- A tela, no sucesso, leva a `/entrar` com o aviso "Senha alterada. Entre com a nova senha." (sem texto de erro, anunciado com educação), e a pessoa entra digitando a senha nova.
- O reset vindo de um convite continua levando o convite: o parâmetro `invite` do link do e-mail segue no `state` da navegação para `/entrar`, e é o **login** que o carrega (`inviteToken`, regra 3a de `specs/auth.md`). A API de reset deixa de aceitar `inviteToken` no corpo, porque não tem mais sessão a manter.
- Saem do contrato, da API, da tela e dos docs `signedIn`, `NO_CONTEXT_ACCESS` e `SIGN_IN_REQUIRED` do reset, a contagem de contextos e a assinatura pós-reset. `NO_CONTEXT_ACCESS` continua existindo no **login** (decisão de 2026-09-24).

**Substitui** a decisão de 2026-09-29 `o-reset-de-senha-sempre-autentica-exceto-sem-nenhum-contexto`, inclusive a correção pós-revisão do PR #176, que não se edita. O que ela dizia sobre o `inviteToken` do **login** (2026-09-29, "O login aceita o token do convite para quem tem zero contextos") segue valendo.

**Consequência.** É mudança de contrato numa rota implantada: o `200` com corpo deixa de existir e o corpo do pedido perde `inviteToken`. Não há migration nem policy nova, e a revogação das sessões antigas continua sendo a de sempre (`revokeSessionsOnPasswordReset`). Uma conta com zero contextos que redefine a senha vê o mesmo que as demais e só encontra o `403 NO_CONTEXT_ACCESS` no login seguinte. A exceção da decisão de 2026-10-07 ("O convite é aceito automaticamente depois do login pelo link") para o `signedIn` da redefinição some junto com ele: quem redefine a senha a partir de um convite entra pelo login que carrega o convite e, como em todo login vindo do link, o aceite automático vale. A SPEC `specs/auth.md` (regra 8a, seção 6, seção 7 e a tabela de rotas) e os READMEs do módulo `auth` e de `invitations` foram acertados no mesmo PR.

**Origem.** Teste manual do dono em 2026-10-16; issue #699.

**Validação.** Validada pelo dono em 2026-10-16.
