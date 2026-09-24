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
- **Troca de e-mail da conta.** Fora do MVP — seção 10.
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

Tudo já existe. **Nenhuma tabela nova, nenhuma coluna nova.**

| tabela | o que importa aqui |
|---|---|
| `auth."user"` | `email` é **único**: é a identidade. `emailVerified` nasce `true` no aceite |
| `auth."account"` | o hash da senha, provider `credential` |
| `auth."session"` | `expiresAt`, com teto absoluto imposto por hook de banco |
| `auth."verification"` | os tokens de recuperação de senha |
| `public.invitations` | guarda **só o hash** do token; nem a operação recupera o token depois de enviado |
| `public.legal_acceptances` | versão de Termos e de Privacidade, com data e hora |
| `public.user_context_preferences` | o último contexto usado, uma linha por usuário |

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
nenhum          → sessão negada          # não cria sessão no login
exatamente um   → entra direto           # decision: 'enter'
mais de um      → escolhe                # decision: 'select'
escolhido       → gravado em last-context # o próximo login entra direto
```

Quem perde o último contexto durante o uso é encerrado na próxima passagem pelo `resolve`.

## 5. Regras invioláveis

1. Senha errada e e-mail inexistente devolvem **a mesma** resposta.
2. `POST /auth/password/forgot` responde igual para e-mail existente e inexistente.
3. Credencial correta com **zero contextos** não cria sessão.
4. Token de convite consumido, expirado ou revogado devolve **o mesmo** `INVALID_LINK`, sem dizer qual dos três.
5. A tela nunca exibe o e-mail do convite antes de o token ser validado pela API.
6. Conta criada por aceite nasce com o e-mail **do convite**, nunca de um campo do formulário.
7. Aceitar os Termos grava as **duas** versões, Termos e Privacidade, com data e hora.
8. Redefinir senha encerra **todas** as sessões.
9. Trocar de contexto grava a preferência e **não** recria a sessão.
10. `401` em qualquer requisição leva ao login preservando o destino, e nunca deixa dado antigo na tela.
11. Quem tem sessão válida e abre uma tela deste módulo é levado ao seu contexto, em vez de logar de novo.

## 6. Backend

### Rotas que já existem

| método | rota | devolve |
|---|---|---|
| `POST` | `/auth/login` | `{ user }` + cookie |
| `POST` | `/auth/logout` | 204 |
| `POST` | `/auth/logout-all` | 204 |
| `GET` | `/auth/session` | `{ user, session: { expiresAt } }` |
| `POST` | `/auth/password/forgot` | 202, sempre |
| `POST` | `/auth/password/reset` | 204, com `inviteToken` opcional |
| `GET` | `/invitations/:token` | preview com `accountExists` |
| `POST` | `/invitations/:token/accept` | `{ status, context }` |
| `POST` | `/invitations/:token/accept-new-account` | `{ status, context }` + cookie |
| `GET` | `/me/contexts` | `{ contexts }` |
| `GET` | `/me/contexts/resolve` | `none` \| `enter` \| `select` |
| `PUT` | `/me/last-context` | 204 |

Limites de tentativa já aplicados por IP, por IP+e-mail e por e-mail global (`policy.ts`): login 10 por 15 min no par IP+e-mail, recuperação 3.

### O que falta implementar

**A checagem de zero contextos**, nos dois pontos decididos:

1. `POST /auth/login` — autentica, conta os contextos e, quando não houver nenhum, **não cria sessão** e devolve um código próprio.
2. `GET /me/contexts/resolve` — `decision: 'none'` passa a encerrar a sessão, em vez de devolver uma aplicação vazia.

É **mudança de contrato numa rota implantada**: os testes de integração de login mudam junto.

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

**O que faz:** `POST /auth/password/reset` com o token da URL e, quando presente na URL, o `inviteToken`. Ao terminar, a pessoa **já está autenticada**: segue direto para o aceite do convite quando houver um, ou para o `resolve`.

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

`POST /invitations/:token/accept`. `already_member` não é erro: leva ao contexto dizendo que o acesso já existia.

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

### Menu de conta

Presente em toda tela autenticada, em todo o produto:

```
┌─────────────────────────┐
│ <Contexto ativo>        │
│ Trocar de contexto      │
├─────────────────────────┤
│ Sair                    │
│ Sair de todas as ses…   │
└─────────────────────────┘
```

É o que torna `POST /auth/logout-all` alcançável, e é onde o seletor de contexto vive durante o uso. Não é tela de perfil — é o menu que a futura tela de perfil vai herdar.

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

**Nenhum dos cinco.** Duas coisas a declarar de todo modo:

1. **`POST /auth/login` muda de contrato** — passa a negar credencial correta sem contexto, e um código de erro novo aparece. Rota implantada, testes de integração alterados junto. Não é estrutural pelos critérios, e não é gratuito.
2. **Vincular identidades seria estrutural** e foi descartado nesta sessão: mudaria o significado de `User`, atravessando RLS, `current_user_id()` e toda tabela que referencia usuário.

## 10. Em aberto

| ponto | gatilho | quem decide |
|---|---|---|
| Troca de e-mail da conta | o primeiro colaborador ou cliente real pedir a troca | Pedro Vidal |
| Reaceite quando Termos ou Privacidade mudar de versão | a primeira alteração de um dos documentos depois de existir gente com conta | Pedro Vidal |

## 11. Decisões registradas

Em [`docs/business/decisions.md`](../docs/business/decisions.md), 2026-09-24:

- Escopo do módulo de autenticação: o que entra, e por que verificação de e-mail já está resolvida
- A mesma pessoa com dois e-mails são duas contas, e identidades não se vinculam
- Credencial correta sem nenhum contexto não cria sessão
- Sete telas de autenticação, com o convite em uma rota e dois estados
- Termos e Privacidade são conteúdo estático versionado, com aceite único

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

**Em aberto:** [#80](https://github.com/Nocrato-Tech/ageniza/issues/80) troca de e-mail · [#81](https://github.com/Nocrato-Tech/ageniza/issues/81) reaceite de Termos.

A [#54](https://github.com/Nocrato-Tech/ageniza/issues/54), que registrava a dívida de "as telas nunca foram desenhadas", foi fechada por este recorte.

### O que pode começar hoje

Duas tasks não esperam design: **#68**, a única de API do épico, e **#71**, que é comportamento do cliente HTTP e do roteador. **#74**, as minutas, também não depende de tela.

As outras nove são `aguardando-design`: nascem escritas a partir do esboço da seção 7, e o código espera a entrega do designer. Sendo onze tasks de web contra uma de API, **o designer é o gargalo real deste módulo** — o backend já existe.
