# Entrada

Este fluxo cobre cadastro, confirmação do e-mail, login, recuperação de senha, convite, termos, perfil e a escolha de onde entrar. Corpo, resposta e erros de cada rota estão na [referência da API](../../api/README.md).

## Rotas

| método | rota | acesso | o que faz |
|---|---|---|---|
| `POST` | `/auth/sign-up` | público | cria uma conta com e-mail e senha |
| `POST` | `/auth/email/verify` | token do link + senha, ou a sessão da conta | confirma o e-mail |
| `POST` | `/auth/email/verification/resend` | público | reenvia o link de confirmação |
| `GET` | `/auth/providers` | público | diz se o Google está ligado |
| `POST` | `/auth/login` | público | entra com e-mail e senha |
| `GET` | `/auth/google/start` | público | leva ao Google |
| `GET` | `/auth/callback/google` | público | volta do Google e cria ou abre a sessão |
| `GET` | `/auth/session` | sessão | sessão e pessoa (renova a sessão) |
| `GET` | `/auth/session/check` | sessão | confere a sessão sem renovar |
| `POST` | `/auth/logout` | sessão | sai deste aparelho |
| `POST` | `/auth/logout-all` | sessão | sai de todos os aparelhos |
| `POST` | `/auth/password/forgot` | público | pede o link de recuperação de senha |
| `POST` | `/auth/password/reset` | público, com o token do link | define a senha nova |
| `GET` | `/me/contexts/resolve` | sessão | decide em qual contexto entrar |
| `GET` | `/me/contexts` | sessão | lista os contextos da pessoa |
| `PUT` | `/me/last-context` | sessão | grava o último contexto usado |
| `POST` | `/agencies` | sessão | cria uma agência em teste grátis |
| `GET` | `/invitations/:token` | token do convite | mostra o convite antes do aceite |
| `POST` | `/invitations/:token/accept-new-account` | token do convite | cria a conta e aceita o convite |
| `POST` | `/invitations/:token/accept` | sessão + token do convite | aceita com a conta logada |
| `GET` | `/me/legal-acceptances` | sessão | versão aceita dos Termos e da Privacidade |
| `POST` | `/me/legal-acceptances` | sessão | aceita um documento |
| `PATCH` | `/me/profile` | sessão | altera o próprio nome |
| `POST` | `/me/photo` | sessão | envia a própria foto |
| `POST` | `/me/email-change` | sessão | pede a troca do e-mail |
| `POST` | `/email-change/confirm` | público, com o token do link | confirma a troca do e-mail |

## Cadastro com e-mail e senha

1. Chame `POST /auth/sign-up` com `name`, `email`, `password` e `acceptTerms: true`.
2. A resposta é sempre `202`, com corpo vazio, exista ou não uma conta com aquele e-mail. Assim, a API não revela quais e-mails estão cadastrados.
3. O link de confirmação chega por e-mail (`/email/verificar?token=`).
4. `POST /auth/email/verify` com o `token` do link e a `password` confirma o e-mail e já abre a sessão. Se a pessoa já está logada nessa conta, basta o token, e a sessão continua a mesma.
5. Se o link não chegou, use `POST /auth/email/verification/resend` com o `email`. O reenvio é limitado a uma vez por minuto; antes disso, a resposta é `429 RATE_LIMITED`.

**Regras**
- **Conta não confirmada não acessa o produto.** As rotas de agência e de portal respondem `403 EMAIL_NOT_CONFIRMED`. O campo `emailVerified` de `GET /auth/session` mostra se o e-mail já foi confirmado.
- O erro `400 INVALID_LINK_OR_PASSWORD` vale para link vencido, link já usado e senha errada. A mensagem é a mesma nos três casos.

## Login

1. `GET /auth/providers` diz se o botão do Google deve aparecer.
2. Com e-mail e senha, use `POST /auth/login` com o cabeçalho `expo-origin` ([como o app entra](../comecar.md#3-como-o-app-entra)); a sessão vem no cookie, que o app guarda e devolve no cabeçalho `Cookie`. O erro `401 INVALID_CREDENTIALS` é o mesmo para e-mail inexistente e para senha errada.
3. Com o Google:
   - abra `GET /auth/google/start?appRedirect=<deep link do app>` num navegador do sistema; a volta é por `GET /auth/callback/google`, que devolve o app ao deep link com `?cookie=<Set-Cookie>` (sucesso) ou `?erro=google` (falha);
   - sem `appRedirect`, a volta é para a web (`/entrar/google`);
   - o deep link precisa estar na lista da API ([como o app entra](../comecar.md#3-como-o-app-entra)).
4. Para conferir a sessão quando o app volta ao primeiro plano, use `GET /auth/session/check`, que não renova a sessão. A web confere a cada 45 s e sempre que a aba volta ao foco, porque a pessoa pode ter sido removida e ter as sessões encerradas.
5. Para sair, use `POST /auth/logout`; para sair de todos os aparelhos, `POST /auth/logout-all`.

**Regra:** um `401` em qualquer rota significa que a sessão acabou. Leve a pessoa para o login.

## Esqueci a senha

1. `POST /auth/password/forgot` com o `email` responde sempre `202`.
2. O link chega por e-mail (`/senha/redefinir?token=`).
3. `POST /auth/password/reset` recebe o token e a senha nova.
4. A redefinição **não abre sessão**: a pessoa precisa entrar de novo. Todas as sessões da conta são encerradas.
5. Erro: `400 INVALID_LINK`, quando o link venceu ou já foi usado.

## Escolher onde entrar (contexto)

A mesma conta pode estar em várias agências e em vários portais de cliente. Depois do login:

1. Chame `GET /me/contexts/resolve`. Para dar preferência a um contexto, passe `?preferred=agency:<id>` ou `?preferred=client:<id>`. O campo `decision` da resposta diz o que fazer:
   - `none`: a pessoa não tem agência nem cliente. Ofereça criar uma agência com `POST /agencies`, passando o `name`. A agência nasce em teste grátis de 14 dias, com a pessoa como Owner.
   - `enter`: entre direto no `context` devolvido.
   - `select`: mostre a lista `contexts` para a pessoa escolher. `highlighted` é o último contexto usado, e `canCreateAgency` diz se ela pode criar outra agência.
2. Ao entrar num contexto, grave a escolha com `PUT /me/last-context`.
3. Para trocar de contexto depois, use a lista de `GET /me/contexts`.

Cada contexto tem um `type`:
- `agency` (com `agencyId`, `roleKey` e `isOwner`) leva aos [fluxos da agência](agencia.md);
- `client` leva ao [portal](portal.md).

## Convite

A agência convida um colaborador ou uma pessoa do portal, e o link chega por e-mail (`/convite/:token`). Quem convidou também pode copiar o link e mandar por outro meio.

1. `GET /invitations/:token` mostra o convite: `purpose` (colaborador ou portal), `email`, a agência ou o cliente, e `accountExists`.
2. Se a pessoa ainda não tem conta (`accountExists: false`), chame `POST /invitations/:token/accept-new-account` com `name`, `password` e `acceptTerms: true`. A conta é criada, o convite é aceito e a sessão abre.
3. Se a pessoa já tem conta, ela entra com o **mesmo e-mail do convite**, e o app chama `POST /invitations/:token/accept`.

**Regras**
- Aceitar pelo link **que chegou por e-mail** confirma o e-mail, porque prova que a pessoa tem acesso àquela caixa de entrada.
- Aceitar pelo link **copiado** por quem convidou não confirma o e-mail; a pessoa ainda precisa confirmar depois.
- O convite expira, e a agência pode cancelar ou reenviar.

**Erros**
- `410 INVALID_LINK`: o convite venceu, foi cancelado ou já foi usado.
- `403 INVITATION_ACCOUNT_MISMATCH`: a pessoa está logada com outro e-mail.
- `409 ACCOUNT_EXISTS`: já existe conta com aquele e-mail; a pessoa deve entrar e aceitar.

## Termos e Privacidade

1. `GET /me/legal-acceptances` devolve um item por documento, com `currentVersion`, `acceptedVersion` e `pending`.
2. Se algum documento estiver `pending`, peça o aceite e chame `POST /me/legal-acceptances` com `{ "document": "terms" }` ou `{ "document": "privacy" }`, um documento por vez.
3. Enquanto houver documento pendente, as rotas de agência e de portal respondem `403 TERMS_NOT_ACCEPTED`.

O cadastro e o aceite de convite já registram o aceite, pelo `acceptTerms: true`. Quando sai uma versão nova dos termos, o aceite é pedido de novo.

## Perfil

- O próprio nome muda por `PATCH /me/profile`, e a própria foto por `POST /me/photo`.
- A troca de e-mail tem três passos:
  1. a pessoa pede com `POST /me/email-change`;
  2. a operação aprova;
  3. o link chega ao e-mail **novo**, e `POST /email-change/confirm` conclui a troca.
