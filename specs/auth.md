# Autenticação, convite e contexto

| | |
|---|---|
| **Status** | aprovado |
| **Submódulos** | sessão e recuperação de senha · aceite de convite · criação de conta · resolução e troca de contexto |
| **Sessões** | 2026-09-24 |
| **Decidido por** | Pedro Vidal, em sessão |

> **O backend existe; a interface não.** As issues #31, #32 e #33 implementaram login, convites e contextos sem nunca passar por uma SPEC, e `apps/web/src` não tem uma tela. Esta SPEC fecha o que faltava: as telas, o que cada uma faz com os dados, e as duas regras de backend que a interface revelou como ausentes.
>
> Ela herda tudo da seção 7 de [`autorizacao.md`](autorizacao.md) — "sem permissão" não é tela, skeleton na primeira carga, mutação invalida as queries que afeta.

## 1. Propósito

Deixar alguém entrar no produto, provar quem é, escolher em qual dos seus contextos vai trabalhar, e sair. Hoje **não existe porta de entrada**: a API inteira está atrás de sessão e nenhum módulo seguinte é validável de ponta a ponta sem isto.

### Não resolve

- ~~**Cadastro público.**~~ e ~~**Verificação de e-mail.**~~ Entram pela seção 13, decidida em 2026-10-26: a conta passa a nascer também por cadastro, com confirmação do e-mail.
- **Troca de senha por quem está logado.** Fora do MVP; a recuperação por link cobre quem perdeu o acesso.
- **Troca de e-mail da conta pela própria pessoa.** A pessoa não troca sozinha: ela pede, e a operação aprova (regras 12 a 18 da seção 5).
- **Vínculo entre identidades.** Dois e-mails são duas contas, e elas não se conhecem.
- ~~**Criação de agência.**~~ Passa a ser fluxo de produto, em trial (seção 13, 2026-10-26). O comando interno continua existindo.
- ~~**Login social.**~~ O Google entra pela seção 13 (2026-10-26). **Segundo fator** continua fora.

## 2. Atores e autorização

Este módulo é a única parte do produto que atende **quem ainda não tem contexto**. Nada aqui depende de permissão nomeada: a autorização começa depois.

| capacidade | quem |
|---|---|
| Entrar, recuperar senha, redefinir senha | qualquer pessoa com credencial |
| Visualizar e aceitar um convite | quem tem o token, que só existe no e-mail de destino |
| Escolher e trocar contexto | qualquer sessão válida com ao menos um contexto |
| Sair, sair de todas as sessões | qualquer sessão válida |

**Owner, papel e cargo não aparecem aqui.** O que o contexto ativo permite é assunto de cada módulo; este só entrega o contexto.

### O que o convite carrega

`GET /invitations/:token` devolve `purpose` (`agency_activation`, `collaborator_invite`, `client_invite`), o e-mail de destino, a agência, o cliente quando houver, e `accountExists`. O papel vem preso ao convite — a pessoa **não escolhe** o próprio papel em nenhum momento.

## 3. Entidades e campos

Quase tudo já existe. **Uma tabela nova** (`email_change_requests`, issue #80, 2026-10-07) e nenhuma coluna nova nas que já existem.

| tabela | o que importa aqui |
|---|---|
| `auth."user"` | `email` é **único**: é a identidade. `emailVerified` nasce `true` no aceite |
| `auth."account"` | o hash da senha, provider `credential` |
| `auth."session"` | `expiresAt`, com teto absoluto de 30 dias imposto pelo `databaseHooks` do Better Auth (JavaScript, não um gatilho do PostgreSQL) e conferido por `session-guard.ts` |
| `auth."verification"` | os tokens de recuperação de senha |
| `public.invitations` | guarda **só o hash** do token; nem a operação recupera o token depois de enviado |
| `public.legal_acceptances` | versão de Termos e de Privacidade, com data e hora. Uma linha por conta, documento e versão: o aceite é **por documento** (regra 7a) |
| `public.user_context_preferences` | o último contexto usado, uma linha por usuário |
| `public.email_change_requests` | o pedido de troca de e-mail: um aberto por conta, com o e-mail antigo e o novo, o estado (`pending`, `approved`, `rejected`, `completed`, `superseded`) e, só quando aprovado, o hash do link e a validade. A aplicação não lê nem escreve a tabela: só pelas duas funções da seção 6 |

## 4. Estados e transições

### Sessão

```
sem sessão → ativa        # login com credencial válida E ao menos um contexto
ativa      → ativa        # 7 dias sem uso, renovada a cada 24 h de uso, teto absoluto de 30 dias
ativa      → encerrada    # logout, logout-all, reset de senha, 7 dias sem uso, ou o teto de 30 dias vencido
```

Não há refresh token e não há nada em JavaScript: cookie httpOnly, `SameSite=lax`.

A conferência periódica da aba aberta (`GET /auth/session/check`, 2026-10-08, #411) **não conta como uso**: lê a sessão sem renová-la, para uma aba esquecida não manter a sessão viva além dos 7 dias sem uso. Quem usa a sessão de verdade (`GET /auth/session`, qualquer rota de negócio) continua renovando.

### Convite

```
válido → aceito           # uso único
válido → inválido         # expirado (7 dias), revogado, ou reenviado (invalida o anterior)
```

As três causas de invalidez são **indistinguíveis** para quem recebe.

### Contexto

```
nenhum          → sessão negada          # não cria sessão no login, salvo inviteToken válido (regra 3a)
exatamente um   → entra direto           # decision: 'enter'
mais de um      → escolhe                # decision: 'select'
escolhido       → gravado em last-context # o próximo login entra direto
```

Quem perde o último contexto durante o uso é encerrado na próxima passagem pelo `resolve`.

## 5. Regras invioláveis

1. Senha errada e e-mail inexistente devolvem **a mesma** resposta.
2. `POST /auth/password/forgot` responde igual para e-mail existente e inexistente.
3. ~~Credencial correta com **zero contextos** não cria sessão~~ — **substituída em 2026-10-26 (§13, implementada na #706):** a conta com e-mail confirmado e sem contexto cria sessão e cai em `/comecar`; `resolve` com `none` mantém a sessão. A conta **não confirmada** não cria sessão, com a senha certa ou não, e o login responde exatamente como credencial inválida nos dois casos (regra 1); sem efeito colateral nenhum: o link novo é pedido pelo reenvio, que a tela oferece (revisões de segurança do PR #722). `NO_CONTEXT_ACCESS` deixou de existir.
3a. Com `inviteToken` válido, a sessão criada continua **sem contexto** até o convite ser aceito por `POST /invitations/:token/accept`; chamar `resolve` antes do aceite encerra essa sessão como qualquer outra sem contexto (regra 3).
4. Token de convite consumido, expirado ou revogado devolve **o mesmo** `INVALID_LINK`, sem dizer qual dos três.
5. A tela nunca exibe o e-mail do convite antes de o token ser validado pela API.
6. Conta criada por aceite nasce com o e-mail **do convite**, nunca de um campo do formulário.
7. No cadastro, aceitar os Termos grava as **duas** versões, Termos e Privacidade, com data e hora.
7a. Depois do cadastro, o aceite é **por documento e por versão** (2026-10-07, pendente de validação): aceitar a Privacidade nunca marca os Termos, e o contrário também. A versão gravada é sempre a **em vigor no servidor** — nunca uma que o cliente envie —, repetir o aceite não grava de novo e aceitar uma versão que a conta já superou não grava nada. A conta fica vinculada à última versão aceita de cada documento, e isso é consultável.
7b. Uma versão mais nova que a aceita **não bloqueia nada**: nem o login, nem rota, nem tela. O único efeito é o aviso da seção 7.
8. Redefinir senha encerra **todas** as sessões.
8a. Redefinir senha **não cria sessão**: troca a senha, encerra todas as sessões (regra 8) e a rota responde `204` sem corpo e sem cookie, tenha a conta contexto ou não. A tela leva a `/entrar` com o aviso "Senha alterada. Entre com a nova senha.", e a pessoa entra digitando a senha nova. Reset vindo de um convite (`invite` no link do e-mail) segue o mesmo caminho, e é o **login** que carrega o convite (`inviteToken`, regra 3a); a rota de reset não recebe `inviteToken` (2026-10-16, substitui a decisão de 2026-09-29 "o reset de senha sempre autentica", com a correção do PR #176; os motivos `NO_CONTEXT_ACCESS` e `SIGN_IN_REQUIRED` do reset deixam de existir, e `NO_CONTEXT_ACCESS` fica só no login).
9. Trocar de contexto grava a preferência e **não** recria a sessão.
10. `401` em qualquer requisição leva ao login preservando o destino, e nunca deixa dado antigo na tela.
11. Quem tem sessão válida e abre uma tela deste módulo é levado ao seu contexto, em vez de logar de novo — **exceto** as telas que precisam abrir para qualquer sessão: `/convite/:token` (quem já está logado aceita o convite pelo fluxo da §7, Convite), `/senha/redefinir`, `/email/confirmar` e `/email/verificar` (o link chega por e-mail e pode ser de outra conta, inclusive para quem já tem sessão) e `/termos` e `/privacidade` (páginas públicas de conteúdo). As demais telas do módulo (`/entrar`, `/sem-acesso`, `/senha/esquecida`) continuam redirecionando ao contexto ativo, e cada exceção tem teste próprio de que a tela abre com sessão válida sem redirecionar (issue #342, 2026-10-07, pendente de validação).
12. A pessoa **não troca o próprio e-mail**: ela pede, pelo menu de conta, informando o e-mail novo e a **senha atual**, e a **operação** aprova pelo CLI (`cli:email-change`), porque a conta é global e o pedido não pertence a nenhuma agência (2026-10-07, pendente de validação). Senha errada não cria pedido. Há **um pedido aberto por conta**; um novo substitui o anterior. O endereço **atual** recebe o aviso "pediram a troca do e-mail desta conta; se não foi você, troque a senha".
13. Aprovado o pedido, um link de **uso único**, válido por 48 horas, vai ao e-mail **novo**. Pedido não aprovado nunca troca nada.
14. Confirmar o link troca o e-mail (marcando-o como verificado), **encerra todas as sessões** da conta e os links de redefinição de senha pendentes, e avisa o endereço **antigo**. Link usado, vencido, substituído ou recusado, e e-mail que outra conta passou a usar, respondem o mesmo `INVALID_LINK`.
15. E-mail novo que já pertence a outra conta recebe **a mesma resposta** de qualquer outro: a rota nunca revela quais e-mails têm conta. A operação vê a colisão ao listar e ao aprovar, e o aprovar é recusado.
16. Conta que é **Owner** de alguma agência: o pedido existe igual, mas aprovar exige a operação confirmar a titularidade fora do produto (`--ownership-confirmed`), porque o e-mail do Owner amarra a assinatura.
17. Convites pendentes endereçados ao e-mail antigo **não mudam**: convite é por e-mail, não por conta.
18. **Trocar a senha desfaz o pedido.** O aviso ao endereço atual diz "se não foi você, troque a senha", então a redefinição de senha encerra o pedido aberto da conta (`superseded`, sem link), e a aprovação e a confirmação recusam um pedido feito sob uma credencial que mudou depois dele, mesmo que o encerramento não tenha rodado: pedir, redefinir a senha, aprovar e confirmar não troca o e-mail. Na confirmação, a conta que virou Owner depois da aprovação, sem a titularidade confirmada, também é recusada (regra 16). Todas as recusas respondem o mesmo `INVALID_LINK` (2026-10-07, pendente de validação).

## 6. Backend

### Rotas que já existem

| método | rota | devolve |
|---|---|---|
| `POST` | `/auth/login` | `{ user }` + cookie. Aceita `inviteToken` opcional (regra 3a). Conta não confirmada: o mesmo `401 INVALID_CREDENTIALS`, com a senha certa ou não |
| `POST` | `/auth/sign-up` | corpo `{ name, email, password, acceptTerms: true }`; `202 {}`, sempre, sem cookie |
| `POST` | `/auth/email/verification/resend` | corpo `{ email }`; `202 {}`, sempre |
| `POST` | `/auth/email/verify` | corpo `{ token, password }`; `{ user }` + cookie, ou `400 INVALID_LINK_OR_PASSWORD` |
| `POST` | `/auth/logout` | 204 |
| `POST` | `/auth/logout-all` | 204 |
| `GET` | `/auth/session` | `{ user, session: { expiresAt } }` |
| `POST` | `/auth/password/forgot` | 202, sempre |
| `POST` | `/auth/password/reset` | 204, sem corpo e sem cookie (regra 8a) |
| `GET` | `/invitations/:token` | preview com `accountExists` |
| `POST` | `/invitations/:token/accept` | `{ status, context }` |
| `POST` | `/invitations/:token/accept-new-account` | `{ status, context }` + cookie |
| `GET` | `/me/contexts` | `{ contexts }` |
| `GET` | `/me/contexts/resolve` | `none` \| `enter` \| `select` |
| `PUT` | `/me/last-context` | 204 |
| `GET` | `/me/legal-acceptances` | `{ documents }`: um item por documento, Termos primeiro, com `currentVersion`, `acceptedVersion` (a mais nova que a conta aceitou, ou `null`) e `pending` |
| `POST` | `/me/legal-acceptances` | corpo `{ document: 'terms' | 'privacy' }`, e nada mais (`.strict()`); responde o mesmo `{ documents }` |
| `POST` | `/me/email-change` | corpo `{ newEmail, currentPassword }`, e nada mais (`.strict()`); `202 {}`. Senha errada é `403 INVALID_PASSWORD` (403, e não 401, que a interface lê como sessão encerrada); o e-mail igual ao atual é `400 SAME_EMAIL`; 5 pedidos por hora e por conta |
| `POST` | `/email-change/confirm` | pública, corpo `{ token }`; `200 {}`, ou `400 INVALID_LINK` para qualquer link que não pode trocar o e-mail |

Limites de tentativa já aplicados por IP, por IP+e-mail e por e-mail global (`policy.ts`): login 10 por 15 min no par IP+e-mail e 50 por hora por e-mail; recuperação 3 por 15 min no par IP+e-mail e 10 por hora por e-mail.

### Implementado (issue #68, PR #164)

**A checagem de zero contextos**, nos dois pontos decididos:

1. `POST /auth/login` — autentica, conta os contextos e, quando não houver nenhum, **não cria sessão** e devolve um código próprio (`403 NO_CONTEXT_ACCESS`) — **exceto** com `inviteToken` válido para o mesmo e-mail (regra 3a, 2026-09-29).
2. `GET /me/contexts/resolve` — `decision: 'none'` encerra a sessão, em vez de devolver uma aplicação vazia.

Foi **mudança de contrato numa rota implantada**: os testes de integração de login mudaram junto. **Desfeito na #706** (regra 3, §13): os dois pontos deixaram de encerrar a sessão da conta confirmada.

### Implementado (issue #81)

**Aceite por documento** (regra 7a), em um módulo próprio, `legal`, sem permissão nomeada — o aceite é da conta, não de um tenant, como em `/me/profile`:

1. `GET /me/legal-acceptances` lê as linhas da própria conta (a policy `legal_acceptances_select` já as limita ao ator) e compara a versão mais nova de cada documento com a em vigor (`AUTH_TERMS_VERSION`, `AUTH_PRIVACY_VERSION`). `pending` é verdadeiro quando a conta nunca aceitou o documento ou aceitou uma versão mais velha.
2. `POST /me/legal-acceptances` chama `app_private.accept_legal_document(document, version)`, uma função `security definer` de escopo único que toma o usuário do ator da transação, nunca de um argumento. Recusa (`A0031`) um documento desconhecido e uma versão que não seja uma data real nem posterior a hoje (no fuso do produto, `America/Sao_Paulo`), e a configuração das versões recusa o mesmo no boot. Retorna sem gravar quando a conta já aceitou aquela versão ou uma mais nova, então é idempotente e nunca regride.
3. `ageniza_app` só **lê** `legal_acceptances`: a tabela é prova de consentimento, e a migration `20261007000500` (issue #343) revoga `insert`, `update` e `delete` do papel, de modo que a escrita direta é recusada pelo privilégio (`permission denied`, `42501`) antes de a RLS ser consultada. Os únicos caminhos de escrita são o aceite de convite (cadastro) e esta função, ambos `security definer`.

O cadastro (`accept-new-account`) não muda: continua gravando as duas versões em vigor, com o checkbox único. Conta anterior a esta entrega sem linha para um documento aparece como pendente; não há backfill.

### Implementado (issue #80)

**Troca de e-mail por pedido** (regras 12 a 18), em um módulo próprio, `email-change`.

**O mecanismo escolhido.** O `changeEmail` do Better Auth 1.7.5 foi avaliado e **não serve**: é autoatendimento (sem senha atual e sem aprovação de ninguém), o token é um JWT assinado que pode ser reapresentado até vencer, não grava pedido nenhum, e não encerra as sessões. Por isso o token é próprio, no mesmo formato do convite: 32 bytes aleatórios, só o hash no banco, uso único.

1. `POST /me/email-change` confere a senha atual contra o hash da conta (`password.verify` do Better Auth) e só então chama `app_private.request_email_change(new_email, verified_hash)` com o hash contra o qual conferiu a senha, função `security definer` que toma a conta do ator da transação, nunca de argumento: normaliza o endereço, recusa o que a conta já tem, substitui o pedido aberto e grava o novo. O endereço atual é avisado, em segundo plano, como a redefinição de senha.
2. A operação usa `cli:email-change`, que conecta como o dono do banco, como o `cli:agency`: `list` mostra os pedidos abertos (com a colisão de e-mail e se a conta é Owner), `approve --request-id <uuid> [--ownership-confirmed]` gera o link e o envia ao e-mail novo, `reject --request-id <uuid>` encerra o pedido. Aprovar de novo um pedido já aprovado e não usado emite um link novo e invalida o anterior, que é como se reenvia.
3. `POST /email-change/confirm` chama `app_private.confirm_email_change(token_hash)`, que numa transação trava o pedido, confere que está aprovado e dentro da validade, que a conta ainda tem o e-mail do pedido e que ninguém passou a usar o novo, troca o e-mail, apaga as sessões e as verificações (links de redefinição) da conta, e fecha o pedido. A API então avisa o endereço antigo.
4. `ageniza_app` não tem privilégio nenhum sobre `email_change_requests`: nem a pessoa lê o próprio pedido.
5. **Ordem de trava única:** os três caminhos que alteram um pedido (pedir, confirmar e aprovar pelo CLI) travam **a conta primeiro e depois os pedidos**; a ordem oposta travava em deadlock (`40P01`) quando dois deles rodavam na mesma conta. Mesmo assim, deadlock e falha de serialização (`40001`) são traduzidos pelas duas rotas em `409 TRY_AGAIN` e, no CLI, em uma mensagem de repetir o comando, sem detalhe do que concorreu.
6. **A credencial é parte do pedido.** `request_email_change` grava a impressão da credencial **que a rota verificou** (SHA-256 do hash da senha, nunca o hash), não a que a conta tem na hora do insert: a senha é conferida numa transação e o pedido gravado em outra, e uma redefinição entre as duas seria gravada como pedido feito sob a senha nova. Com a conta travada, a função também compara o hash verificado com a credencial atual e recusa (`A0042`; a rota responde o mesmo 403 de senha errada, sem gravar nem avisar) se a redefinição chegou primeiro. Barreira 1: a redefinição de senha (`onPasswordReset`) chama `app_private.supersede_email_change_requests(user_id)`, que trava a conta e fecha os pedidos abertos cuja impressão não é mais a da conta (a função só fecha o que a barreira 2 recusaria, então chamá-la sem troca de credencial não cancela ninguém). Barreira 2: o `approve` do CLI e `confirm_email_change` recusam o pedido cuja impressão mudou, com mensagem própria no CLI ("The account password changed since the request…", fechando o pedido) e o mesmo `INVALID_LINK` na confirmação. Hoje a redefinição é o único caminho de troca de senha (não há troca autenticada, e a rota do Better Auth não é montada); um caminho novo precisa chamar a mesma função e ganha a barreira 2 de graça. `confirm_email_change` também recusa a conta que é Owner de alguma agência e não teve a titularidade confirmada na aprovação (`ownership_confirmed_at` nulo).

**Limitações aceitas.** Recusar um pedido não avisa a pessoa (a operação fala com ela fora do produto). A operação descobre os pedidos rodando `list`; não há notificação. Quem perdeu o acesso ao e-mail antigo **e** à senha continua sem caminho: recuperação de conta fica fora do MVP. O teto de pedidos é em memória, como o dos demais limites de autenticação.

### Implementado (issues #175 e #699)

**`POST /auth/password/reset` não cria sessão** (regra 8a):

1. A senha é redefinida (o que já encerra **todas** as sessões antigas, regra 8).
2. A rota responde `204`, sem corpo e sem cookie. Não conta contextos nem assina de volta: o corpo do pedido é só `{ token, newPassword }`, e um `inviteToken` ali é recusado como qualquer campo desconhecido.

Um token de reset inválido, usado ou expirado devolve `400 INVALID_LINK`, sem sessão.

Desde 2026-09-29 (issue #175) a rota assinava a pessoa de volta e respondia `signedIn`, com os motivos `NO_CONTEXT_ACCESS` e `SIGN_IN_REQUIRED` (correção da revisão de segurança do PR #176). A decisão de 2026-10-16 (issue #699) tirou tudo isso: foi **mudança de contrato numa rota implantada**, o `200` com corpo voltou a `204`, e os testes de integração mudaram junto.

### Implementado (issues #706 e #713)

**Cadastro público e confirmação do e-mail** (§13, com o achado A1 da revisão do PR #720 e a revisão de segurança do PR #721):

1. `POST /auth/sign-up` cria a conta com `emailVerified = false`, a credencial e os dois aceites (Termos e Privacidade, nas versões em vigor), e emite o link de confirmação. Não cria sessão. O `disableSignUp` do Better Auth continua ligado: a rota é nossa. A senha é transformada em hash nos dois caminhos e os e-mails saem em segundo plano, então e-mail novo, conta confirmada e conta não confirmada recebem a mesma resposta no mesmo tempo. O e-mail que já tem conta, confirmada ou não, recebe só um aviso **sem link**, apontando para "Esqueci a senha".
2. **O link é nosso, com estado**: o `emailVerification` do Better Auth é um JWT sem estado que leva o e-mail, não é de uso único, sobrevive ao reenvio e confirma sem senha, e não é usado. O token tem 32 bytes aleatórios e não carrega nada; o banco guarda só o SHA-256 em `public.email_confirmations` (`user_id`, `expires_at` de 24 h, `consumed_at`), que `ageniza_app` não lê nem escreve: tudo passa por `app_private.issue_email_confirmation`, `email_confirmation_by_token_hash` e `consume_email_confirmation`. Emitir um link novo apaga os não consumidos da conta. No código, `issueEmailConfirmation(executor, userId)` (`apps/api/src/modules/auth/email-verification.ts`) emite e devolve o token para `emailService.sendEmailVerification`; é o que o aceite de convite da #721 chama.
3. `POST /auth/email/verify` pede o token **e a senha da conta**. Conta as tentativas nos contadores do login (senha errada aqui gasta as mesmas tentativas de `/entrar`). Link inválido, vencido, usado e senha errada dão a mesma resposta, `400 INVALID_LINK_OR_PASSWORD`, sem mudar nada; a senha é conferida também contra um hash fictício quando o link não vale, para o tempo não denunciar o link. Com link e senha certos, a função consome o link só se a credencial ainda for a conferida (uma redefinição no meio faz falhar), marca o e-mail como confirmado, apaga os outros links e a rota cria a sessão.
4. `POST /auth/email/verification/resend` emite um link novo só para conta não confirmada, e responde `202 {}` para qualquer endereço.
5. **A redefinição assume a conta não confirmada**: o `onPasswordReset` chama `app_private.confirm_email_by_password_reset(user_id)`, que apaga os links pendentes da conta, marca o e-mail como confirmado e revoga (`revoked_at`) os aceites gravados por quem cadastrou. A redefinição continua sem criar sessão (regra 8a).
6. O login de conta não confirmada responde o mesmo `401 INVALID_CREDENTIALS` da senha errada, com a senha certa ou não, e não tem efeito colateral: não reenvia o link nem gasta o contador do reenvio, que respondendo 429 só para o endereço sem conta seria outro oráculo (revisões de segurança do PR #722). A rota confere a senha ela mesma (contra um hash falso quando o e-mail não tem credencial) e recusa a conta não confirmada antes de o Better Auth entrar, por isso o `requireEmailVerification` dele está desligado. A guarda de sessão recusa e revoga a sessão de conta não confirmada, como segunda barreira.
6b. **Exceção do convite** (decisão do link de convite copiável, 2026-10-26, em parte substituída pela de 2026-10-27, "o aceite pelo link do e-mail confirma o e-mail"): `accept-new-account` pelo **token do e-mail** cria a conta confirmada, sem e-mail de confirmação, e entra com ela; pelo **token copiado** (e no convite de portal) cria a conta não confirmada, emite na mesma transação o link de confirmação, envia o e-mail e entra com ela, e `POST /auth/email/verify` confirma então **sem senha** quando a requisição traz a sessão da própria conta do link; sem essa sessão, ou com a de outra conta, continua pedindo a senha e responde, sem ela, o mesmo `400 INVALID_LINK_OR_PASSWORD`. A guarda aceita a sessão dessa conta só enquanto `app_private.unconfirmed_account_may_hold_session` encontra o vínculo que o convite deu (a agência de que é dona, ou o vínculo ativo na agência ou no cliente do convite); a conta que se cadastrou nunca aceitou convite e não entra na exceção, e a removida de tudo perde a sessão. A exceção dura enquanto o contexto do convite seria listado: agência suspensa ou cliente arquivado também a encerram, como em `contexts/service.ts` (migration `20261027010400`). O login por senha continua fechado a ela até confirmar, com o mesmo 401, para não distinguir conta com convite (ponto em aberto abaixo).
6a. Confirmar e redefinir a senha não se sobrepõem: `consume_email_confirmation` trava a credencial antes de compará-la (migration `20261027010200`), então a troca de senha espera a confirmação terminar ou a confirmação vê a senha nova e recusa. Se o login falhar depois de o link ser consumido (a senha mudou no meio), a rota responde `400 INVALID_LINK_OR_PASSWORD`, nunca 500; a conta está confirmada e a pessoa entra com a senha nova.
7. Limites (`policy.ts`): cadastro e reenvio, 30 por 15 min por IP, 3 por 15 min no par IP+e-mail e 10 por hora por e-mail; confirmação, 100 por 15 min por IP, além dos contadores do login.

**Limitações e pontos em aberto.** A falta de aceite depois da revogação **não bloqueia** a conta que não tem Google: para ela só o aviso de documento pendente aparece. Para a conta com Google (§13, regras 7 e 7b) o bloqueio vale na listagem de contextos, na criação de agência e em toda rota de agência e de portal (403 `TERMS_NOT_ACCEPTED`). "Criar agência" em `/comecar` aparece desabilitado até a #709. A conta não confirmada criada pelo convite, quando a sessão acaba, não entra de novo por senha até confirmar o e-mail (o link chegou no aceite, e o reenvio e a redefinição seguem abertos); a decisão do link copiável e a primeira versão da §13 diziam que ela "entra nos contextos que tem" pelo login, mas abrir o login por senha só para ela faria o login responder diferente para conta com convite. O código fica com o caminho mais restritivo, e a decisão de 2026-10-27 registra isso no lugar do texto antigo. A confirmar com o dono do produto.

### Persistência

Migrations `20261027010000` (`legal_acceptances.revoked_at`, a unicidade por versão passa a valer só entre os não revogados, e `confirm_email_by_password_reset`) `20261027010100` (`email_confirmations` e as suas funções) `20261027010200` (a confirmação trava a credencial) e `20261027010300` (`unconfirmed_account_may_hold_session`, a exceção do convite) e `20261027010400` (a exceção segue o status da agência e do cliente) e `20261027050000` (`invitations.email_token_hash`, os dois tokens do convite e `app_private.invitation_token_came_by_email`).

### RLS

Nenhuma policy nova. `email_confirmations` tem RLS ligada e forçada, sem policy e sem privilégio para `ageniza_app`: só as funções `security definer` a alcançam.

## 7. Frontend

Sete telas. Os esboços são wireframe: **o que existe e onde**, para o designer desenhar. Nada de cor, tipografia ou espaçamento.

As rotas do navegador são em português; as da API continuam em inglês.

### Entrar — `/entrar`

```
┌──────────────────────────────────┐
│           Ageniza                │
│                                  │
│  E-mail    [____________]        │
│  Senha     [____________]        │
│                                  │
│           [ Entrar ]             │
│                                  │
│  Esqueci minha senha             │
└──────────────────────────────────┘
```

**O que faz com os dados:** `POST /auth/login` → em caso de sucesso, `GET /me/contexts/resolve` → `enter` vai para o contexto, `select` vai para `/contextos`, `none` vai para acesso encerrado.

**Erros:** credencial inválida e e-mail inexistente mostram a **mesma** mensagem. Limite de tentativas atingido diz para tentar mais tarde. Nenhum dos dois limpa o campo de e-mail.

**Validação na tela:** e-mail em formato inválido: "Informe um e-mail válido."; senha vazia: "Informe a sua senha." A tela **não confere o tamanho da senha** (a regra de 10 caracteres é de quem cria uma senha, no convite e na redefinição): qualquer senha preenchida vai ao servidor, que responde "E-mail ou senha incorretos." Cada mensagem fica no seu campo e o foco vai ao primeiro campo inválido; **não há o resumo "Corrija N campos"** neste formulário, exceção à regra comum registrada em 2026-10-16.

**Layout:** da largura de 64rem para cima, a tela é de duas colunas: à esquerda o painel de marca (o mascote amigável centralizado sobre a cor da marca, encostado nas bordas da tela) e à direita o formulário, afastado da borda e em largura de formulário. Abaixo disso o painel some e o formulário ocupa a tela. O mesmo molde vale para esqueci a senha, redefinir, convite e confirmação de e-mail (2026-10-16).

**Sem cadastro:** não há "criar conta". Quem chega sem convite não tem o que fazer aqui, e a tela diz isso em uma linha em vez de oferecer um caminho que não existe. *Substituído pela seção 13 (2026-10-26): a tela ganha "Entrar com o Google" e "Criar conta".*

### Esqueci a senha — `/senha/esquecida`

```
┌──────────────────────────────────┐
│  Recuperar acesso                │
│                                  │
│  E-mail    [____________]        │
│                                  │
│        [ Enviar link ]           │
│                                  │
│  Voltar para entrar              │
└──────────────────────────────────┘
```

**O que faz:** `POST /auth/password/forgot`. A confirmação é **sempre a mesma**, exista o e-mail ou não: "se existir uma conta com esse endereço, o link chegou".

### Redefinir senha — `/senha/redefinir?token=…`

```
┌──────────────────────────────────┐
│  Definir nova senha              │
│                                  │
│  Nova senha    [____________]    │
│  (mínimo 10 caracteres)          │
│                                  │
│        [ Salvar ]                │
└──────────────────────────────────┘
```

**O que faz:** `POST /auth/password/reset` com o token da URL. O parâmetro `invite` da própria URL (`/senha/redefinir?token=…&invite=…`) não vai no pedido: acompanha a pessoa até o login. Ao terminar, a pessoa **não está autenticada** (regra 8a) e vai para `/entrar` com o aviso "Senha alterada. Entre com a nova senha." (sem texto de erro, anunciado com educação). A sessão que o navegador ainda guardava é descartada antes de navegar, senão a regra 11 levaria a pessoa de `/entrar` ao contexto e o aviso se perderia. Com `invite`, o login que se segue leva o convite adiante (regra 3a), e `NO_CONTEXT_ACCESS` só aparece, como sempre, no login de quem não tem nenhum contexto e nenhum convite válido (2026-10-16).

**Link inválido** é estado desta tela: token usado ou expirado mostra que o link não vale mais e oferece pedir outro, sem dizer qual dos dois casos ocorreu.

### Convite — `/convite/:token`

Uma rota, dois estados, escolhidos por `accountExists`.

**Cabeçalho comum aos dois** — é o que a pessoa precisa reconhecer antes de aceitar:

```
┌────────────────────────────────────────┐
│  Você foi convidado                    │
│  Agência: <nome>                       │
│  Cliente: <nome>   (quando houver)     │
│  Convite enviado para <e-mail>         │
├────────────────────────────────────────┤
```

**Estado A — já tem conta:**

```
│        [ Aceitar convite ]             │
│  Entrar com outra conta                │
└────────────────────────────────────────┘
```

`POST /invitations/:token/accept`. `already_member` não é erro: o aceite segue normalmente até o destino do próprio convite — a agência ou o portal — e, no topo de onde a pessoa cai, um aviso discreto diz "Você já fazia parte de `<Agência>`. Nada mudou no seu acesso." O aviso aparece uma vez e some ao ser fechado ou quando a pessoa navega (2026-10-07, pendente de validação).

**Aceite automático depois do login.** Quem clica em "Aceitar convite" sem sessão vai para `/entrar` levando o token. Depois do login, quando o e-mail da conta é o do convite, o aceite acontece **sem novo clique** e a pessoa cai na agência ou no portal **do convite**, nunca no contexto que a sessão resolveria. Quando o e-mail é outro, **nada é aceito**: a tela do convite explica que ele foi enviado para outro endereço e oferece sair e entrar com a conta certa. O marcador que arma esse aceite vive só no `state` da navegação: um parâmetro equivalente na URL não dispara nada. Convite vencido ou revogado continua o mesmo `INVALID_LINK` de sempre (2026-10-07, pendente de validação).

**Estado B — não tem conta:**

```
│  Nome         [____________]           │
│  Senha        [____________]           │
│  (mínimo 10 caracteres)                │
│                                        │
│  [x] Li e aceito os Termos de Uso e a  │
│      Política de Privacidade           │
│                                        │
│        [ Criar conta e entrar ]        │
└────────────────────────────────────────┘
```

`POST /invitations/:token/accept-new-account`. **O e-mail não é campo** — vem do convite e aparece apenas como informação. O checkbox é um só, com os dois links dentro do texto, e é obrigatório.

**Link inválido** é estado desta tela, e vem antes de qualquer outra coisa: nada do convite aparece se o token não valer.

### Escolher contexto — `/contextos`

```
┌────────────────────────────────────────┐
│  Onde você quer entrar?                │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ <Agência>            Admin       │  │ ← destacado quando
│  │ agência                          │  │   highlighted
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ <Cliente>                        │  │
│  │ portal do cliente · <Agência>    │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
```

**O que faz:** renderiza a lista que `resolve` devolveu — **não** chama `/me/contexts` de novo e **não** recalcula a ordem. Escolher grava `PUT /me/last-context` e entra.

**Cada item mostra:** nome, se é área da agência ou portal do cliente, o papel quando for agência, e a agência dona quando for cliente — sem isso, alguém com o mesmo nome de cliente em duas agências não consegue distinguir.

### Acesso encerrado — `/sem-acesso`

```
┌────────────────────────────────────────┐
│  Sua conta não tem acesso a nenhum     │
│  espaço de trabalho.                   │
│                                        │
│  Fale com quem administra a agência    │
│  para receber um convite.              │
│                                        │
│        [ Voltar para entrar ]          │
└────────────────────────────────────────┘
```

Chega-se aqui com credencial **correta** e zero contextos. Não é erro de senha, e a tela não pode sugerir que seja — é o único momento em que o produto precisa dizer "não é você, é o vínculo". Nenhuma sessão existe ao exibi-la.

### Termos — `/termos` · Privacidade — `/privacidade`

Páginas públicas de conteúdo estático versionado, com a versão visível. Alcançáveis pelos links do checkbox e diretamente pela URL.

### Aviso de documento atualizado

No topo da casca da agência e do portal, **não bloqueante**, quando a versão em vigor de Termos ou de Privacidade é mais nova que a última aceita pela conta. Um item por documento pendente:

```
┌──────────────────────────────────────────────────────────────┐
│ Atualizamos os Termos de Uso. Ler os Termos de Uso           │
│ [Li e aceito]                                                │
│ Atualizamos a Política de Privacidade. Ler a Política …      │
│ [Li e aceito]                                       [Fechar] │
└──────────────────────────────────────────────────────────────┘
```

- O link abre `/termos` ou `/privacidade` em outra aba, e **Li e aceito** registra só aquele documento; os outros itens ficam.
- **Fechar** esconde o aviso sem aceitar nada. Ele volta no próximo login, porque o fechamento vive só no cache da sessão.
- Quem já aceitou as versões em vigor não vê nada. Falha ao ler a situação não mostra aviso nem erro, e falha ao aceitar mantém o item e diz que não foi possível registrar.
- Não aparece em `/contextos`, nas telas públicas nem em nenhuma outra: só nas duas cascas.

### Menu de conta

Presente em toda tela autenticada, em todo o produto:

```
┌─────────────────────────┐
│ <Contexto ativo>        │
│ Trocar de contexto      │
│ Pedir troca de e-mail   │
├─────────────────────────┤
│ Sair                    │
│ Sair de todas as ses…   │
└─────────────────────────┘
```

É o que torna `POST /auth/logout-all` alcançável, e é onde o seletor de contexto vive durante o uso. Não é tela de perfil — é o menu que a futura tela de perfil vai herdar.

### Pedir troca de e-mail

Item do menu de conta que abre uma janela com **Novo e-mail** e **Senha atual**. Confere o formato na tela e envia só os dois campos. Senha errada aparece no campo da senha; e-mail igual ao atual, no campo do e-mail; excesso de tentativas e falha de rede, como mensagem da janela, que pode ser repetida. Ao enviar, diz que o pedido foi feito, que o e-mail atual foi avisado e que a operação analisa; **não diz nada sobre o e-mail novo**, porque a resposta é a mesma quando outra conta já o usa.

### Confirmar novo e-mail — `/email/confirmar?token=…`

Tela pública do link que a aprovação envia ao e-mail novo. **Pede um clique** em vez de confirmar ao abrir: um leitor de e-mail que abre o link não pode gastá-lo. O token sai da barra de endereço assim que a tela o guarda. Ao confirmar, mostra que o e-mail mudou e que todas as sessões foram encerradas, descarta o estado local da sessão e leva a **Entrar**. Link inválido, usado ou vencido mostra o estado "Este link não é mais válido", com a validade de 48 horas.

### Estados de tela

| estado | comportamento |
|---|---|
| **Carregando** | skeleton na primeira carga; o botão de cada formulário mostra progresso e fica desabilitado, sem travar a tela |
| **Erro de rede** | a mensagem oferece repetir a ação, nunca só informa |
| **Sessão expirada** | leva ao login preservando o destino, e devolve a pessoa ao mesmo lugar depois |
| **Já autenticado** | qualquer tela deste módulo redireciona ao contexto ativo, **exceto** `/convite/:token`, `/senha/redefinir`, `/email/confirmar`, `/termos` e `/privacidade`, que abrem com qualquer sessão (regra 11) |

### Idioma

Português. A API já responde em português ao usuário, e as duas camadas não podem divergir.

## 8. Infraestrutura

Nada novo. O e-mail transacional de convite e de recuperação já existe (issue #19), com Mailpit no ambiente local.

## 9. Impacto estrutural

- [ ] altera tabela que já existe
- [ ] muda formato de resposta que outras rotas copiam
- [ ] mexe em RLS de mais de um módulo
- [ ] muda como a autorização é avaliada
- [ ] exigiria backfill

**Nenhum dos cinco.** Quatro coisas a declarar de todo modo:

1. **`POST /auth/login` muda de contrato** — passa a negar credencial correta sem contexto, e um código de erro novo aparece. Rota implantada, testes de integração alterados junto. Não é estrutural pelos critérios, e não é gratuito.
2. **Vincular identidades seria estrutural** e foi descartado nesta sessão: mudaria o significado de `User`, atravessando RLS, `current_user_id()` e toda tabela que referencia usuário.
3. **O aceite por documento (2026-10-07, pendente de validação)** muda o contrato de aceite e abre um segundo caminho de escrita em dado pessoal, a função `app_private.accept_legal_document`. Nenhuma tabela, coluna ou policy de `legal_acceptances` muda, e não há backfill; o registro está em `decisions.md`. Os grants de escrita sobre a tabela foram revogados depois, pela issue #343 (decisão de 2026-10-07, também pendente de validação).
4. **A troca de e-mail por pedido (2026-10-07, pendente de validação)** cria uma tabela, duas rotas e um e-mail transacional, e abre um caminho de escrita sobre o e-mail em `auth."user"` por função `security definer`. Não altera tabela que já existe e não precisa de backfill; o registro está em `decisions.md`.

## 10. Em aberto

Nada em aberto hoje: o reaceite de Termos e a troca de e-mail foram decididos em 2026-10-07 (seção 11).

## 11. Decisões registradas

Em [`docs/business/decisions.md`](../docs/business/decisions.md), 2026-09-24:

- Escopo do módulo de autenticação: o que entra, e por que verificação de e-mail já está resolvida
- A mesma pessoa com dois e-mails são duas contas, e identidades não se vinculam
- Credencial correta sem nenhum contexto não cria sessão
- Sete telas de autenticação, com o convite em uma rota e dois estados
- Termos e Privacidade são conteúdo estático versionado, com aceite único no cadastro

E, 2026-10-07 (**pendente de validação**): Termos e Privacidade mudam de versão sem forçar o reaceite, e o aceite depois do cadastro é por documento — fecha o ponto em aberto sobre o reaceite.

E, 2026-10-07 (**pendente de validação**): a troca de e-mail da conta é um pedido aprovado pela operação, não uma edição — fecha o ponto em aberto sobre a troca de e-mail.

E, 2026-10-07 (**pendente de validação**): a regra 11 tem exceções — convite, redefinir senha, confirmar e-mail, Termos e Privacidade abrem com sessão válida sem redirecionar; as demais telas do módulo redirecionam ao contexto ativo (issue #342).

E, 2026-10-07 (**pendente de validação**): a sessão vale 7 dias sem uso, é renovada a cada 24 h de uso e tem teto absoluto de 30 dias — alinha a SPEC ao que o código e os testes já faziam (issue #341).

E, 2026-09-29 (**pendente de validação**): o login aceita o token do convite para quem tem zero contextos, complementando a decisão de 2026-09-24 sobre credencial correta sem contexto.

E, 2026-10-07 (**pendente de validação**): o aviso de `already_member` aparece uma vez no destino, e o aceite automático depois do login vale só para o e-mail do convite — com outra conta conectada, nada é aceito e a tela explica.

E, herdadas de [`autorizacao.md`](autorizacao.md): "sem permissão" não é tela, os três tratamentos de carregamento, e mutação invalidando as queries que afeta.

## 12. Recorte de implementação

**Épico [#62](https://github.com/Nocrato-Tech/ageniza/issues/62)** — nenhuma history isolada cobre o módulo.

| history | tasks | escopo |
|---|---|---|
| [#63](https://github.com/Nocrato-Tech/ageniza/issues/63) Entrar e sair | [#69](https://github.com/Nocrato-Tech/ageniza/issues/69) tela Entrar · [#70](https://github.com/Nocrato-Tech/ageniza/issues/70) menu de conta · [#71](https://github.com/Nocrato-Tech/ageniza/issues/71) 401 como fim de sessão | web |
| [#64](https://github.com/Nocrato-Tech/ageniza/issues/64) Recuperar a senha | [#72](https://github.com/Nocrato-Tech/ageniza/issues/72) esqueci a senha · [#73](https://github.com/Nocrato-Tech/ageniza/issues/73) redefinir senha | web |
| [#65](https://github.com/Nocrato-Tech/ageniza/issues/65) Aceitar convite | [#74](https://github.com/Nocrato-Tech/ageniza/issues/74) minutas · [#75](https://github.com/Nocrato-Tech/ageniza/issues/75) páginas legais · [#76](https://github.com/Nocrato-Tech/ageniza/issues/76) tela Convite | web |
| [#66](https://github.com/Nocrato-Tech/ageniza/issues/66) Escolher e trocar de contexto | [#77](https://github.com/Nocrato-Tech/ageniza/issues/77) tela `/contextos` · [#78](https://github.com/Nocrato-Tech/ageniza/issues/78) seletor no menu | web |
| [#67](https://github.com/Nocrato-Tech/ageniza/issues/67) Negar acesso sem vínculo | [#68](https://github.com/Nocrato-Tech/ageniza/issues/68) zero contextos no login e no resolve · [#79](https://github.com/Nocrato-Tech/ageniza/issues/79) tela Acesso encerrado | api · web |

**Em aberto:** nenhum.

**Decididas em 2026-10-07:** [#81](https://github.com/Nocrato-Tech/ageniza/issues/81), reaceite de Termos — aviso não bloqueante com aceite por documento (seção 7, regra 7a); [#80](https://github.com/Nocrato-Tech/ageniza/issues/80), troca de e-mail — pedido aprovado pela operação (seção 5, regras 12 a 18); e [#342](https://github.com/Nocrato-Tech/ageniza/issues/342), as exceções da regra 11 — telas que abrem com sessão válida (seção 5, regra 11, e seção 7).

A [#54](https://github.com/Nocrato-Tech/ageniza/issues/54), que registrava a dívida de "as telas nunca foram desenhadas", foi fechada por este recorte.

### O que pode começar hoje

Duas tasks não esperam design: **#68**, a única de API do épico, e **#71**, que é comportamento do cliente HTTP e do roteador. **#74**, as minutas, também não depende de tela.

As outras nove são `aguardando-design`: nascem escritas a partir do esboço da seção 7, e o código espera a entrega do designer. Sendo onze tasks de web contra uma de API, **o designer é o gargalo real deste módulo** — o backend já existe.

## 13. Entrada aberta (2026-10-26)

Decidida em sessão pelo dono do produto. As regras de segurança derivadas pelo maestro estão **pendentes de validação**, e várias vieram da revisão do PR #720. Épico [#718](https://github.com/Nocrato-Tech/ageniza/issues/718), tasks #706 a #717. Cada decisão tem o seu arquivo, e esta seção junta o que muda neste módulo. Onde ela contradiz as seções 1 a 12, vale esta seção. As seções antigas são reescritas quando cada parte for implementada.

| decisão | o que muda aqui |
|---|---|
| [Cadastro público com e-mail e senha](../docs/business/decisions/2026-10-26-estrutural-cadastro-publico-com-e-mail-e-senha-e-confirmacao.md) | `/criar-conta`; confirmação do e-mail por link de 24 h **com a senha da conta**; o login de conta não confirmada responde como credencial inválida, com a senha certa ou não, sem efeito colateral (revisões de segurança do PR #722); a redefinição de senha de conta não confirmada assume a conta; cadastro num e-mail que já tem conta manda só o aviso; conta confirmada sem contexto cria sessão (a regra 3 muda) |
| [Entrar com o Google](../docs/business/decisions/2026-10-26-estrutural-entrar-com-google-e-a-conta-que-o-google-assume.md) | botão nas telas de entrada; só vale e-mail verificado pelo Google; a conta Google é identificada pelo `sub`; `accountLinking` só para o Google; o Google assume a conta de e-mail não confirmado e mata senha, sessões, redefinições, confirmações, trocas de e-mail pendentes e o aceite de Termos (que ganha `revoked_at` em `legal_acceptances`); conta só com Google reautentica pelo Google onde hoje se pede a senha |
| [Agência nasce pelo produto, em trial](../docs/business/decisions/2026-10-26-estrutural-a-agencia-nasce-pelo-produto-em-trial-de-14-dias.md) | "Criar agência" na tela sem contexto e no seletor de contexto, só para e-mail verificado; 14 dias, 3 clientes, 3 colaboradores, 2 GB; somente leitura ao fim, com as ações que reduzem acesso liberadas; uma agência em trial por e-mail normalizado; limite diário de e-mails; upgrade por comando interno |
| [Link do convite de colaborador copiável](../docs/business/decisions/2026-10-26-estrutural-o-link-do-convite-de-colaborador-pode-ser-copiado.md) | criar e reenviar devolvem o link uma vez, com `no-store`; `accept-new-account` deixa de marcar o e-mail como verificado e envia a confirmação; essa conta tem sessão antes de confirmar, como exceção explícita (a regra 6 não muda) |
| [O aceite pelo link do e-mail confirma o e-mail](../docs/business/decisions/2026-10-27-estrutural-o-aceite-pelo-link-do-e-mail-confirma-o-e-mail.md) | o convite de colaborador tem dois tokens de uso único (e-mail e "Copiar link"); o aceite pelo do e-mail cria a conta confirmada; pelo copiado, não confirmada, e `/email/verificar` confirma sem senha só com a sessão da própria conta; a ativação de agência usa o token do e-mail; o portal fica como está. Substitui em parte o item 2 do link copiável |
| [Link de confirmação com estado e sessão da conta de convite](../docs/business/decisions/2026-10-27-estrutural-token-de-confirmacao-com-estado-e-sessao-da-conta-de-convite.md) | o link de confirmação é nosso, com estado; o login de conta não confirmada não tem efeito colateral; a conta de convite só tem a sessão do aceite, enquanto o contexto for listado; a redefinição que assume a conta revoga o aceite. Vale sobre o item 2 do cadastro e o item 2 do link copiável |
| [Acesso ao portal por e-mail](../docs/business/decisions/2026-10-26-estrutural-o-acesso-ao-portal-e-por-e-mail-e-a-conta-e-opcional.md) | o acesso passa à conta **no login**, quando uma conta com aquele e-mail verificado entra, e nunca em "Adicionar pessoa" |

### Telas novas ou alteradas

- **`/criar-conta`**: nome, e-mail, senha, aceite único de Termos e Privacidade, "Criar conta" e "Entrar com o Google". Depois de enviar, a tela é sempre a mesma: "enviamos um link para o seu e-mail", com reenvio. Vindo do link de aprovação ("Criar conta para ver o portal"), o campo de e-mail chega preenchido pelo estado da navegação (nunca pela URL) e a pessoa pode trocá-lo; a tela não diz se o endereço já tem conta.
- **`/email/verificar?token=…`**: tira o token da barra de endereço ao abrir, como `/email/confirmar`, e pede **a senha da conta** e um clique, **exceto** quando o navegador já tem a sessão da própria conta do link (a conta criada pelo link copiado do convite): aí a tela oferece "Confirmar sem digitar a senha" (decisão de 2026-10-27), que envia só o token e mantém a sessão; se a API recusar (link de outra conta, link morto), a tela diz isso e segue com o campo de senha. Token válido e senha certa verificam o e-mail e criam a sessão da conta confirmada, trocando a que houvesse no navegador. Senha errada responde como credencial inválida e não consome o token. Abre com qualquer sessão, como exceção nova da regra 11.
- **`/entrar`**: ganha "Entrar com o Google" e "Criar conta". Abaixo do erro de credencial, sempre, "Criou a conta e não confirmou? Reenviar o link de confirmação", ligado ao reenvio (revisão de segurança do PR #722: a tela nunca diz que a conta existe e não foi confirmada). A conta não confirmada criada pelo aceite de convite usa a sessão que o próprio aceite criou, com o aviso "confirme o seu e-mail" e o reenvio; se essa sessão acaba, o `/entrar` responde como credencial inválida, e ela volta a entrar confirmando o e-mail pelo link do aceite, pelo reenvio ou por "Esqueci a senha".
- **`/comecar`**, para conta confirmada sem contexto, toma o lugar de `/sem-acesso` nesse caso. Oferece "Criar agência", pedindo só o nome, e explica que convites e acessos ao portal aparecem aqui quando chegarem.
- **Seletor de contexto e `/contextos`**: item fixo "Criar agência", escondido quando a pessoa já tem uma agência em trial e quando o e-mail não está confirmado.
- **Primeiro login pelo Google sem conta, ou depois de o Google assumir a conta**: aceite de Termos e Privacidade antes do primeiro uso.

### O que muda nas regras invioláveis

- **Regra 3**: a conta com e-mail verificado e sem contexto cria sessão. A conta não confirmada criada pelo aceite de convite tem sessão antes de confirmar, como exceção explícita; sem contexto, ela volta à regra 3.
- **Regras 7, 7a e 7b**: o aceite gravado antes de o dono do e-mail assumir a conta é revogado (`revoked_at`; o registro fica), e o aceite é pedido de novo antes do primeiro uso. Na regra 7a, "repetir o aceite não grava de novo" passa a valer só entre os aceites não revogados: depois da revogação, aceitar a mesma versão grava uma linha nova. A falta de aceite bloqueia em dois casos, e só neles: a conta assumida, e a conta nova pelo Google antes do primeiro aceite. Nos dois, sem o aceite não há contexto.
- **Regra 8**: redefinir a senha de uma conta não confirmada também marca o e-mail como verificado e invalida as confirmações pendentes. As sessões continuam encerradas, agora pela data da troca.
- **Regra 11**: `/email/verificar` entra na lista das telas que abrem com qualquer sessão.
- **Regra 12**: a conta só com Google pede a troca de e-mail com a reautenticação recente pelo Google, no lugar da senha atual.
- **Regra 18**: a impressão de credencial do pedido usa o `sub` da conta Google quando não há senha, e o Google assumir a conta encerra os pedidos abertos, como a redefinição.

### Implementado: entrar com o Google (issue #707)

A API do Google está pronta (rotas `/auth/providers`, `/auth/google/start` e `/auth/callback/google`); as telas estão em "Implementado: as telas do Google (issue #713)", logo abaixo. O que a implementação decidiu além do texto acima está em [Entrar com o Google, o que a implementação decidiu](../docs/business/decisions/2026-10-27-estrutural-entrar-com-o-google-o-que-a-implementacao-decidiu.md), pendente de validação do dono: uma identidade Google por conta; reautenticação recente é a sessão de até 5 minutos criada com `prompt=login`; o bloqueio do aceite é uma regra derivada (conta com Google sem os dois aceites ativos), na listagem de contextos e na criação de agência; a URL de retorno é `APP_PUBLIC_URL/api/auth/callback/google`, ou `GOOGLE_CALLBACK_URL`. Sem as credenciais o Google fica desligado (404, e o campo `google` de `/auth/providers` é falso).

### Implementado: as telas do Google (issue #713)

- **O botão** "Entrar com o Google" aparece em `/entrar` e em `/criar-conta`, abaixo do formulário e do "ou", só quando `GET /auth/providers` responde `google: true`. Qualquer outra coisa (desligado, erro, resposta fora do contrato) esconde o botão e o "ou" e deixa o formulário inteiro. É um link para `/auth/google/start` na API (o caminho base da API, como `/api`, é mantido). O botão também está na tela do convite (`/convite/:token`, para quem ainda não está conectado) e na entrada que carrega um convite, como o dono decidiu em 2026-10-26: o convite atravessa a ida ao Google no `sessionStorage` da aba (o link é só `/auth/google/start`, sem o token), é gasto uma vez na volta e vale 10 minutos (guardado com a hora, `savedAt`); é apagado também na recusa (`/entrar?erro=google`), na volta da reautenticação, no login por senha e no logout, para que uma visita posterior a `/entrar/google` na mesma aba não aceite um convite de uma viagem que acabou. Quem aceita é a tela do convite, só quando o e-mail da sessão é o do convite; com outro e-mail aparece o erro que o convite já mostra e nada é aceito nem vinculado.
- **A volta** é `/entrar/google`: a tela espera a leitura da sessão que publica (a do próprio `refresh()` pode ser a descartada quando o aplicativo assina o store depois) e entrega a decisão ao `/entrar`, que resolve o destino como depois da senha, então a entrada pelo Google não chega a lugar onde a senha não chegue; com um convite guardado, volta à tela do convite. Sem sessão, é a mesma recusa de qualquer outra falha.
- **A rota recusada pelo aceite**: uma tela de `/agencia/:id` ou de `/portal/:id` que recebe `403 TERMS_NOT_ACCEPTED` leva ao `/aceite` e, depois do aceite, volta ao endereço pedido (só endereço do próprio aplicativo).
- **A recusa** `/entrar?erro=google` mostra uma frase só, a mesma de senha errada (`E-mail ou senha incorretos.`), sem motivo, e não a repete ao lado de uma falha de senha na mesma tela.
- **O aceite** `/aceite`: a conta bloqueada recebe `none` do resolve, cai em `/comecar` e daí vai ao aceite. Uma caixa só ("Li e aceito os Termos de Uso e a Política de Privacidade", ou só o documento que falta), os documentos são gravados um a um, na ordem da API, e uma falha no segundo mantém o primeiro: a nova tentativa envia só o que sobrou. Sem nada a aceitar a pessoa segue pelo `/entrar`. O seletor de contextos (`/contextos`) não lê os aceites.
- **A troca de e-mail** da conta só com Google: com o Google ligado, o diálogo oferece "Não tenho senha, entro com o Google", que tira o campo de senha e envia o pedido sem ela. Se a sessão tem mais de 5 minutos, a API responde `REAUTH_REQUIRED` e o diálogo mostra "Confirme com o Google para continuar." com o botão "Confirmar com o Google" (`/auth/google/start?intent=reauth`). A volta (`/entrar/google?intent=reauth`) leva ao endereço de onde a pessoa saiu e reabre o diálogo já nesse modo; só se segue endereço do próprio aplicativo. Se a API responder que a conta tem senha, o diálogo volta ao campo de senha. O endereço digitado não sobrevive ao desvio pelo Google.
- Decisões de tela tomadas na implementação, pendentes de validação do dono: [Entrar com o Google, as telas](../docs/business/decisions/2026-10-27-entrar-com-o-google-as-telas.md).

### O que fica igual

As regras invioláveis 1, 2, 3a, 4 a 6, 8a, 9, 10 e 13 a 17. A regra 8a vale também para a redefinição que assume uma conta não confirmada: ela não cria sessão, e a pessoa entra com a senha nova; a resposta igual para e-mail existente e inexistente, agora também no cadastro e no reenvio da confirmação; o convite de uso único, com só o hash no banco; o teto de sessão.
