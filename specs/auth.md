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

- **Cadastro público.** Não existe e não vai existir: conta nasce de convite (`disableSignUp: true` no Better Auth).
- **Verificação de e-mail.** Já está satisfeita — a conta nasce `emailVerified = true` porque o convite chegou naquele endereço.
- **Troca de senha por quem está logado.** Fora do MVP; a recuperação por link cobre quem perdeu o acesso.
- **Troca de e-mail da conta pela própria pessoa.** A pessoa não troca sozinha: ela pede, e a operação aprova (regras 12 a 18 da seção 5).
- **Vínculo entre identidades.** Dois e-mails são duas contas, e elas não se conhecem.
- **Criação de agência.** É comando interno da operação, não fluxo de produto.
- **Login social e segundo fator.** Nunca entraram em pauta.

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
| `auth."session"` | `expiresAt`, com teto absoluto imposto por hook de banco |
| `auth."verification"` | os tokens de recuperação de senha |
| `public.invitations` | guarda **só o hash** do token; nem a operação recupera o token depois de enviado |
| `public.legal_acceptances` | versão de Termos e de Privacidade, com data e hora. Uma linha por conta, documento e versão: o aceite é **por documento** (regra 7a) |
| `public.user_context_preferences` | o último contexto usado, uma linha por usuário |
| `public.email_change_requests` | o pedido de troca de e-mail: um aberto por conta, com o e-mail antigo e o novo, o estado (`pending`, `approved`, `rejected`, `completed`, `superseded`) e, só quando aprovado, o hash do link e a validade. A aplicação não lê nem escreve a tabela: só pelas duas funções da seção 6 |

## 4. Estados e transições

### Sessão

```
sem sessão → ativa        # login com credencial válida E ao menos um contexto
ativa      → ativa        # renovada a cada 24h de uso, até o teto de 7 dias
ativa      → encerrada    # logout, logout-all, reset de senha, ou o teto vencido
```

Não há refresh token e não há nada em JavaScript: cookie httpOnly, `SameSite=lax`.

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
3. Credencial correta com **zero contextos** não cria sessão — **salvo** quando o login carrega `inviteToken` de um convite válido para o mesmo e-mail (regra 3a, 2026-09-29, pendente de validação). A mesma exceção vale para `POST /auth/password/reset`: a senha é sempre trocada, mas a sessão só é criada se, depois de contar os contextos, houver pelo menos um, ou se um `inviteToken` válido para o mesmo e-mail cobrir o caso de zero (regra 8a, 2026-09-29).
3a. Com `inviteToken` válido, a sessão criada continua **sem contexto** até o convite ser aceito por `POST /invitations/:token/accept`; chamar `resolve` antes do aceite encerra essa sessão como qualquer outra sem contexto (regra 3).
4. Token de convite consumido, expirado ou revogado devolve **o mesmo** `INVALID_LINK`, sem dizer qual dos três.
5. A tela nunca exibe o e-mail do convite antes de o token ser validado pela API.
6. Conta criada por aceite nasce com o e-mail **do convite**, nunca de um campo do formulário.
7. No cadastro, aceitar os Termos grava as **duas** versões, Termos e Privacidade, com data e hora.
7a. Depois do cadastro, o aceite é **por documento e por versão** (2026-10-07, pendente de validação): aceitar a Privacidade nunca marca os Termos, e o contrário também. A versão gravada é sempre a **em vigor no servidor** — nunca uma que o cliente envie —, repetir o aceite não grava de novo e aceitar uma versão que a conta já superou não grava nada. A conta fica vinculada à última versão aceita de cada documento, e isso é consultável.
7b. Uma versão mais nova que a aceita **não bloqueia nada**: nem o login, nem rota, nem tela. O único efeito é o aviso da seção 7.
8. Redefinir senha encerra **todas** as sessões.
8a. Redefinir senha **sempre autentica** quem redefiniu, pelo mesmo mecanismo do login — **salvo** quando a conta tem zero contextos e não há `inviteToken` válido para o mesmo e-mail: nesse caso a senha é trocada, mas nenhuma sessão é criada, e a resposta diz o motivo (`signedIn: false, reason: 'NO_CONTEXT_ACCESS'`), para a tela levar a `/sem-acesso` (2026-09-29, substitui o comportamento anterior de `204` sem sessão fora do fluxo de convite). Contagem de contextos e sessão nova nessa ordem: primeiro conta, só então assina — assim uma conta confirmada em zero contextos nunca chega a ter sessão para revogar. Fora do caso confirmado de zero, qualquer outra falha em criar a sessão pós-reset — a conta não ser encontrada, a contagem falhar, ou o `signInEmail` falhar (inclusive dois links de reset válidos da mesma conta disputando a senha) — usa um motivo diferente, `signedIn: false, reason: 'SIGN_IN_REQUIRED'`, para a tela levar a `/entrar` em vez de `/sem-acesso`: `NO_CONTEXT_ACCESS` só quando o zero foi de fato confirmado (achado da revisão de segurança do PR #176, 2026-09-29).
9. Trocar de contexto grava a preferência e **não** recria a sessão.
10. `401` em qualquer requisição leva ao login preservando o destino, e nunca deixa dado antigo na tela.
11. Quem tem sessão válida e abre uma tela deste módulo é levado ao seu contexto, em vez de logar de novo.
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
| `POST` | `/auth/login` | `{ user }` + cookie. Aceita `inviteToken` opcional (regra 3a) |
| `POST` | `/auth/logout` | 204 |
| `POST` | `/auth/logout-all` | 204 |
| `GET` | `/auth/session` | `{ user, session: { expiresAt } }` |
| `POST` | `/auth/password/forgot` | 202, sempre |
| `POST` | `/auth/password/reset` | `200 { signedIn: true }` ou `200 { signedIn: false, reason }` (`'NO_CONTEXT_ACCESS'` ou `'SIGN_IN_REQUIRED'`), com `inviteToken` opcional (regra 8a) |
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

Limites de tentativa já aplicados por IP, por IP+e-mail e por e-mail global (`policy.ts`): login 10 por 15 min no par IP+e-mail, recuperação 3.

### Implementado (issue #68, PR #164)

**A checagem de zero contextos**, nos dois pontos decididos:

1. `POST /auth/login` — autentica, conta os contextos e, quando não houver nenhum, **não cria sessão** e devolve um código próprio (`403 NO_CONTEXT_ACCESS`) — **exceto** com `inviteToken` válido para o mesmo e-mail (regra 3a, 2026-09-29).
2. `GET /me/contexts/resolve` — `decision: 'none'` encerra a sessão, em vez de devolver uma aplicação vazia.

Foi **mudança de contrato numa rota implantada**: os testes de integração de login mudaram junto.

### Implementado (issue #81)

**Aceite por documento** (regra 7a), em um módulo próprio, `legal`, sem permissão nomeada — o aceite é da conta, não de um tenant, como em `/me/profile`:

1. `GET /me/legal-acceptances` lê as linhas da própria conta (a policy `legal_acceptances_select` já as limita ao ator) e compara a versão mais nova de cada documento com a em vigor (`AUTH_TERMS_VERSION`, `AUTH_PRIVACY_VERSION`). `pending` é verdadeiro quando a conta nunca aceitou o documento ou aceitou uma versão mais velha.
2. `POST /me/legal-acceptances` chama `app_private.accept_legal_document(document, version)`, uma função `security definer` de escopo único que toma o usuário do ator da transação, nunca de um argumento. Recusa (`A0031`) um documento desconhecido e uma versão que não seja uma data real nem posterior a hoje (no fuso do produto, `America/Sao_Paulo`), e a configuração das versões recusa o mesmo no boot. Retorna sem gravar quando a conta já aceitou aquela versão ou uma mais nova, então é idempotente e nunca regride.
3. `ageniza_app` continua **sem INSERT direto** em `legal_acceptances`: a tabela é prova de consentimento, e os únicos caminhos de escrita são o aceite de convite (cadastro) e esta função.

O cadastro (`accept-new-account`) não muda: continua gravando as duas versões em vigor, com o checkbox único. Conta anterior a esta entrega sem linha para um documento aparece como pendente; não há backfill.

### Implementado (issue #80)

**Troca de e-mail por pedido** (regras 12 a 18), em um módulo próprio, `email-change`.

**O mecanismo escolhido.** O `changeEmail` do Better Auth 1.7.5 foi avaliado e **não serve**: é autoatendimento (sem senha atual e sem aprovação de ninguém), o token é um JWT assinado que pode ser reapresentado até vencer, não grava pedido nenhum, e não encerra as sessões. Por isso o token é próprio, no mesmo formato do convite: 32 bytes aleatórios, só o hash no banco, uso único.

1. `POST /me/email-change` confere a senha atual contra o hash da conta (`password.verify` do Better Auth) e só então chama `app_private.request_email_change(new_email)`, função `security definer` que toma a conta do ator da transação, nunca de argumento: normaliza o endereço, recusa o que a conta já tem, substitui o pedido aberto e grava o novo. O endereço atual é avisado, em segundo plano, como a redefinição de senha.
2. A operação usa `cli:email-change`, que conecta como o dono do banco, como o `cli:agency`: `list` mostra os pedidos abertos (com a colisão de e-mail e se a conta é Owner), `approve --request-id <uuid> [--ownership-confirmed]` gera o link e o envia ao e-mail novo, `reject --request-id <uuid>` encerra o pedido. Aprovar de novo um pedido já aprovado e não usado emite um link novo e invalida o anterior, que é como se reenvia.
3. `POST /email-change/confirm` chama `app_private.confirm_email_change(token_hash)`, que numa transação trava o pedido, confere que está aprovado e dentro da validade, que a conta ainda tem o e-mail do pedido e que ninguém passou a usar o novo, troca o e-mail, apaga as sessões e as verificações (links de redefinição) da conta, e fecha o pedido. A API então avisa o endereço antigo.
4. `ageniza_app` não tem privilégio nenhum sobre `email_change_requests`: nem a pessoa lê o próprio pedido.
5. **Ordem de trava única:** os três caminhos que alteram um pedido (pedir, confirmar e aprovar pelo CLI) travam **a conta primeiro e depois os pedidos**; a ordem oposta travava em deadlock (`40P01`) quando dois deles rodavam na mesma conta. Mesmo assim, deadlock e falha de serialização (`40001`) são traduzidos pelas duas rotas em `409 TRY_AGAIN` e, no CLI, em uma mensagem de repetir o comando, sem detalhe do que concorreu.
6. **A credencial é parte do pedido.** `request_email_change` grava uma impressão da credencial da conta (`app_private.credential_fingerprint`: SHA-256 do hash da senha, nunca o hash; nula se a conta não tem senha). Barreira 1: a redefinição de senha (`onPasswordReset`) chama `app_private.supersede_email_change_requests(user_id)`, que trava a conta e fecha os pedidos abertos cuja impressão não é mais a da conta (a função só fecha o que a barreira 2 recusaria, então chamá-la sem troca de credencial não cancela ninguém). Barreira 2: o `approve` do CLI e `confirm_email_change` recusam o pedido cuja impressão mudou, com mensagem própria no CLI ("The account password changed since the request…", fechando o pedido) e o mesmo `INVALID_LINK` na confirmação. Hoje a redefinição é o único caminho de troca de senha (não há troca autenticada, e a rota do Better Auth não é montada); um caminho novo precisa chamar a mesma função e ganha a barreira 2 de graça. `confirm_email_change` também recusa a conta que é Owner de alguma agência e não teve a titularidade confirmada na aprovação (`ownership_confirmed_at` nulo).

**Limitações aceitas.** Recusar um pedido não avisa a pessoa (a operação fala com ela fora do produto). A operação descobre os pedidos rodando `list`; não há notificação. Quem perdeu o acesso ao e-mail antigo **e** à senha continua sem caminho: recuperação de conta fica fora do MVP. O teto de pedidos é em memória, como o dos demais limites de autenticação.

### Implementado (issue #175)

**`POST /auth/password/reset` sempre autentica** (regra 8a), pelo mesmo mecanismo de `signInEmail` que já existia no ramo com convite:

1. A senha é redefinida (o que já encerra **todas** as sessões antigas, regra 8).
2. Sem `inviteToken` válido: conta os contextos **antes** de assinar. Com zero confirmado, não tenta assinar — responde direto `200 { signedIn: false, reason: 'NO_CONTEXT_ACCESS' }`, sem cookie. Com pelo menos um, assina de volta com a senha nova; se a assinatura der certo, mantém a sessão e responde `200 { signedIn: true }` com cookie; se a assinatura falhar mesmo com contexto confirmado (falha transitória, ou dois links de reset válidos da mesma conta em paralelo), responde `200 { signedIn: false, reason: 'SIGN_IN_REQUIRED' }` — nunca `NO_CONTEXT_ACCESS`, que fica reservado ao zero confirmado.
3. Com `inviteToken` válido para o mesmo e-mail: comportamento inalterado desde a issue #68/#76 — assina de volta incondicionalmente, sessão sem contexto até o aceite, `200 { signedIn: true }`; se essa assinatura falhar, `200 { signedIn: false, reason: 'SIGN_IN_REQUIRED' }` (nunca `NO_CONTEXT_ACCESS`, já que um `inviteToken` válido prova que a conta não está no caso de zero).

Um token de reset inválido, usado ou expirado continua devolvendo o mesmo `400 INVALID_LINK` de sempre, sem sessão — não é afetado por esta mudança.

**`SIGN_IN_REQUIRED` (2026-09-29, achado da revisão de segurança do PR #176).** A primeira versão desta rota devolvia `NO_CONTEXT_ACCESS` para qualquer falha em criar a sessão pós-reset, inclusive para quem tem contexto — a revisão reproduziu isso com uma falha transitória na contagem e com dois tokens de reset válidos da mesma conta em paralelo. `NO_CONTEXT_ACCESS` passa a significar exclusivamente "contagem confirmou zero"; qualquer outra causa (conta não identificável, contagem falhando, `signInEmail` falhando) usa `SIGN_IN_REQUIRED`, e a tela leva a `/entrar` em vez de `/sem-acesso`. A senha muda nos dois casos.

Foi **mudança de contrato numa rota implantada**: o `204` anterior (fora do ramo de convite) vira `200` com corpo; os testes de integração mudaram junto.

### Persistência

Nenhuma migration.

### RLS

Nenhuma policy nova. A contagem de contextos usa o caminho que `listValidContexts` já percorre.

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

**Sem cadastro:** não há "criar conta". Quem chega sem convite não tem o que fazer aqui, e a tela diz isso em uma linha em vez de oferecer um caminho que não existe.

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

**O que faz:** `POST /auth/password/reset` com o token da URL e, quando presente, o parâmetro `invite` da própria URL (`/senha/redefinir?token=…&invite=…`). Ao terminar, a pessoa **já está autenticada** (regra 8a) na maioria dos casos. `signedIn: true` segue direto para o aceite do convite quando houver um, ou para o `resolve`. `signedIn: false` tem dois motivos, com destinos diferentes: `NO_CONTEXT_ACCESS` vai direto para `/sem-acesso`, sem passar por `resolve` — a senha já foi trocada, mas a conta confirmadamente não tem contexto; `SIGN_IN_REQUIRED` vai para `/entrar` com uma mensagem de que a senha foi redefinida e é preciso entrar com ela — a senha também já foi trocada, mas a sessão não pôde ser criada por um motivo que não prova ausência de contexto (2026-09-29, achado da revisão de segurança do PR #176).

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
| **Já autenticado** | qualquer tela deste módulo redireciona ao contexto ativo |

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
3. **O aceite por documento (2026-10-07, pendente de validação)** muda o contrato de aceite e abre um segundo caminho de escrita em dado pessoal, a função `app_private.accept_legal_document`. Nenhuma tabela, coluna, grant ou policy de `legal_acceptances` muda, e não há backfill; o registro está em `decisions.md`.
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

**Decididas em 2026-10-07:** [#81](https://github.com/Nocrato-Tech/ageniza/issues/81), reaceite de Termos — aviso não bloqueante com aceite por documento (seção 7, regra 7a); e [#80](https://github.com/Nocrato-Tech/ageniza/issues/80), troca de e-mail — pedido aprovado pela operação (seção 5, regras 12 a 18).

A [#54](https://github.com/Nocrato-Tech/ageniza/issues/54), que registrava a dívida de "as telas nunca foram desenhadas", foi fechada por este recorte.

### O que pode começar hoje

Duas tasks não esperam design: **#68**, a única de API do épico, e **#71**, que é comportamento do cliente HTTP e do roteador. **#74**, as minutas, também não depende de tela.

As outras nove são `aguardando-design`: nascem escritas a partir do esboço da seção 7, e o código espera a entrega do designer. Sendo onze tasks de web contra uma de API, **o designer é o gargalo real deste módulo** — o backend já existe.
