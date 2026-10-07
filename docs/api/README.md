# API do Ageniza — referência

> Gerado por `pnpm api:docs` a partir dos schemas de `packages/contracts`. Não edite à mão.
> Documento OpenAPI 3.1: [`openapi.json`](./openapi.json).

Em desenvolvimento (`pnpm dev`) a interface interativa fica em <http://127.0.0.1:3001/docs>.
Fora de desenvolvimento a rota **não existe**: o inventário da API não é publicado sem necessidade.

## Como a API autentica

A sessão é um cookie httpOnly, `SameSite=lax`, emitido por `POST /auth/login`; não há token no
corpo nem na URL. Cada requisição de tenant informa na própria rota em qual agência ou cliente
está atuando (`/agencies/:agencyId/...`, `/clients/:clientId/...`), e a guarda revalida o
vínculo a cada chamada. Agência inexistente, suspensa ou fora do alcance devolve **404**
indistinto, nunca 403: a existência não é confirmada.

## Formato de erro

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Agency not found."
  },
  "meta": {
    "requestId": "req-de-exemplo"
  }
}
```

Cada rota lista os erros que pode devolver, incluindo os globais: qualquer uma pode responder
`500 INTERNAL_ERROR`, as de escrita também `403 CSRF_REJECTED`, e as que
recebem corpo `413 PAYLOAD_TOO_LARGE`. As mensagens em português são as que o
produto mostra; as demais são internas.

## Rotas por módulo

### system — Saúde e prontidão do processo.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `GET` | `/health` | Público | — | Verifica se o processo está vivo |
| `GET` | `/ready` | Público | — | Verifica se a API está pronta para receber tráfego |

#### `GET /health`

Verifica se o processo está vivo.

- Acesso: Público.
- Permissão: —.

**Resposta `200`** — Processo vivo.

```json
{
  "status": "ok"
}
```

**Erros:** Nenhum.

#### `GET /ready`

Verifica se a API está pronta para receber tráfego.

- Acesso: Público.
- Permissão: —.

**Resposta `200`** — Pronta.

```json
{
  "status": "ok"
}
```

**Erros:** `503 NOT_READY`

### auth — Login, sessão, logout e recuperação de senha.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `POST` | `/auth/login` | Público | — | Autentica com e-mail e senha |
| `POST` | `/auth/logout` | Sessão | — | Encerra a sessão atual |
| `POST` | `/auth/logout-all` | Sessão | — | Encerra todas as sessões da conta |
| `GET` | `/auth/session` | Sessão | — | Devolve a sessão e a pessoa autenticada |
| `POST` | `/auth/password/forgot` | Público | — | Pede o link de recuperação de senha |
| `POST` | `/auth/password/reset` | Público | — | Redefine a senha e tenta autenticar de volta |

#### `POST /auth/login`

Autentica com e-mail e senha.

- Acesso: Público.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "email": "dono@exemplo.test",
  "password": "<senha-do-exemplo>"
}
```

**Resposta `200`** — Sessão criada; o cookie httpOnly vem na resposta.

```json
{
  "user": {
    "id": "55555555-5555-4555-8555-555555555555",
    "name": "Dono da Agência",
    "email": "dono@exemplo.test"
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 INVALID_CREDENTIALS` · `403 CSRF_REJECTED` · `403 NO_CONTEXT_ACCESS` · `429 RATE_LIMITED` · `500 INTERNAL_ERROR`

#### `POST /auth/logout`

Encerra a sessão atual.

- Acesso: Sessão.
- Permissão: —.

**Resposta `204`** — Sessão encerrada.

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `500 INTERNAL_ERROR`

#### `POST /auth/logout-all`

Encerra todas as sessões da conta.

- Acesso: Sessão.
- Permissão: —.

**Resposta `204`** — Todas as sessões encerradas.

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `500 INTERNAL_ERROR`

#### `GET /auth/session`

Devolve a sessão e a pessoa autenticada.

- Acesso: Sessão.
- Permissão: —.

**Resposta `200`** — Sessão válida.

```json
{
  "user": {
    "id": "55555555-5555-4555-8555-555555555555",
    "name": "Dono da Agência",
    "email": "dono@exemplo.test"
  },
  "session": {
    "expiresAt": "2026-10-01T12:00:00.000Z"
  }
}
```

**Erros:** `401 SESSION_EXPIRED` · `401 UNAUTHENTICATED` · `500 INTERNAL_ERROR`

#### `POST /auth/password/forgot`

Pede o link de recuperação de senha.

- Acesso: Público.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "email": "dono@exemplo.test"
}
```

**Resposta `202`** — Pedido aceito.

```json
{}
```

**Erros:** `400 VALIDATION_ERROR` · `403 CSRF_REJECTED` · `429 RATE_LIMITED` · `500 INTERNAL_ERROR`

#### `POST /auth/password/reset`

Redefine a senha e tenta autenticar de volta.

- Acesso: Público.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "token": "<token-do-exemplo>",
  "newPassword": "<nova-senha-do-exemplo>"
}
```

**Resposta `200`** — Senha redefinida; a sessão depende do resultado.

```json
{
  "signedIn": true
}
```

**Erros:** `400 INVALID_LINK` · `400 VALIDATION_ERROR` · `403 CSRF_REJECTED` · `429 RATE_LIMITED` · `500 INTERNAL_ERROR`

### invitations — Convite de colaborador e de pessoa do portal, aceite e administração dos pendentes.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `GET` | `/agencies/:agencyId/invitations` | Sessão + vínculo com a agência | `colaborador.convidar` | Lista os convites de colaborador pendentes |
| `POST` | `/agencies/:agencyId/invitations/collaborators` | Sessão + vínculo com a agência | `colaborador.convidar` | Convida uma pessoa para a agência |
| `POST` | `/agencies/:agencyId/clients/:clientId/invitations` | Sessão + vínculo com a agência | `cliente.convidar_usuario` | Convida uma pessoa para o portal de um cliente |
| `POST` | `/agencies/:agencyId/invitations/:invitationId/resend` | Sessão + vínculo com a agência | `convite.reenviar` | Reenvia um convite pendente |
| `DELETE` | `/agencies/:agencyId/invitations/:invitationId` | Sessão + vínculo com a agência | `convite.cancelar` | Cancela um convite pendente |
| `GET` | `/invitations/:token` | Token do convite | — | Mostra o convite antes do aceite |
| `POST` | `/invitations/:token/accept-new-account` | Token do convite | — | Cria a conta e aceita o convite |
| `POST` | `/invitations/:token/accept` | Sessão + token do convite | — | Aceita o convite com a conta já autenticada |

#### `GET /agencies/:agencyId/invitations`

Lista os convites de colaborador pendentes.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `colaborador.convidar`.

**Requisição** (`application/json`):

```json
{
  "page": 1,
  "pageSize": 20
}
```

**Resposta `200`** — Página de convites pendentes.

```json
{
  "data": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "email": "colaborador@exemplo.test",
      "purpose": "collaborator_invite",
      "role": {
        "key": "production",
        "name": "Produção"
      },
      "client": null,
      "createdAt": "2026-09-25T12:00:00.000Z",
      "expiresAt": "2026-10-02T12:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/invitations/collaborators`

Convida uma pessoa para a agência.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `colaborador.convidar`.

**Requisição** (`application/json`):

```json
{
  "email": "colaborador@exemplo.test",
  "roleId": "66666666-6666-4666-8666-666666666666"
}
```

**Resposta `201`** — Convite criado e enviado.

```json
{
  "invitationId": "33333333-3333-4333-8333-333333333333",
  "expiresAt": "2026-10-02T12:00:00.000Z",
  "supersededInvitationId": null
}
```

**Erros:** `400 INVALID_ROLE` · `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 MEMBERSHIP_EXISTS` · `409 TRY_AGAIN` · `500 INTERNAL_ERROR` · `502 EMAIL_DELIVERY_FAILED`

#### `POST /agencies/:agencyId/clients/:clientId/invitations`

Convida uma pessoa para o portal de um cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.convidar_usuario`.

**Requisição** (`application/json`):

```json
{
  "email": "pessoa@exemplo.test"
}
```

**Resposta `201`** — Convite criado e enviado.

```json
{
  "invitationId": "33333333-3333-4333-8333-333333333333",
  "expiresAt": "2026-10-02T12:00:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 MEMBERSHIP_EXISTS` · `409 TRY_AGAIN` · `500 INTERNAL_ERROR` · `502 EMAIL_DELIVERY_FAILED`

#### `POST /agencies/:agencyId/invitations/:invitationId/resend`

Reenvia um convite pendente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `convite.reenviar`.

**Resposta `200`** — Convite reenviado.

```json
{
  "invitationId": "33333333-3333-4333-8333-333333333333",
  "expiresAt": "2026-10-02T12:00:00.000Z"
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 INVITATION_NOT_PENDING` · `409 TRY_AGAIN` · `500 INTERNAL_ERROR` · `502 EMAIL_DELIVERY_FAILED`

#### `DELETE /agencies/:agencyId/invitations/:invitationId`

Cancela um convite pendente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `convite.cancelar`.

**Resposta `204`** — Convite cancelado.

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 INVITATION_NOT_PENDING` · `409 TRY_AGAIN` · `500 INTERNAL_ERROR`

#### `GET /invitations/:token`

Mostra o convite antes do aceite.

- Acesso: Token do convite.
- Permissão: —.

**Resposta `200`** — Convite válido.

```json
{
  "purpose": "collaborator_invite",
  "email": "pessoa@exemplo.test",
  "agency": {
    "name": "Agência Exemplo"
  },
  "client": null,
  "accountExists": true
}
```

**Erros:** `410 INVALID_LINK` · `500 INTERNAL_ERROR`

#### `POST /invitations/:token/accept-new-account`

Cria a conta e aceita o convite.

- Acesso: Token do convite.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "name": "Pessoa Convidada",
  "password": "<senha-do-exemplo>",
  "acceptTerms": true
}
```

**Resposta `201`** — Conta criada, convite aceito e sessão iniciada.

```json
{
  "status": "accepted",
  "context": {
    "agencyId": "11111111-1111-4111-8111-111111111111",
    "clientId": null
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `403 CSRF_REJECTED` · `409 ACCOUNT_EXISTS` · `409 TRY_AGAIN` · `410 INVALID_LINK` · `500 INTERNAL_ERROR`

#### `POST /invitations/:token/accept`

Aceita o convite com a conta já autenticada.

- Acesso: Sessão + token do convite.
- Permissão: —.

**Resposta `200`** — Convite aceito ou vínculo já existente.

```json
{
  "status": "accepted",
  "context": {
    "agencyId": "11111111-1111-4111-8111-111111111111",
    "clientId": null
  }
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 INVITATION_ACCOUNT_MISMATCH` · `409 TRY_AGAIN` · `410 INVALID_LINK` · `500 INTERNAL_ERROR`

### contexts — Listagem, resolução e troca de contexto, e o primeiro acesso ao portal do cliente.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `GET` | `/me/contexts` | Sessão | — | Lista os contextos válidos da pessoa |
| `GET` | `/me/contexts/resolve` | Sessão | — | Resolve em qual contexto entrar |
| `PUT` | `/me/last-context` | Sessão | — | Grava o último contexto usado |
| `POST` | `/clients/:clientId/onboarding/seen` | Sessão + vínculo com o cliente | — | Marca o primeiro acesso ao portal do cliente |

#### `GET /me/contexts`

Lista os contextos válidos da pessoa.

- Acesso: Sessão.
- Permissão: —.

**Resposta `200`** — Contextos válidos.

```json
{
  "contexts": [
    {
      "type": "agency",
      "agencyId": "11111111-1111-4111-8111-111111111111",
      "agencyName": "Agência Exemplo",
      "roleKey": "admin",
      "roleName": "Admin",
      "isOwner": true
    }
  ]
}
```

**Erros:** `401 UNAUTHENTICATED` · `500 INTERNAL_ERROR`

#### `GET /me/contexts/resolve`

Resolve em qual contexto entrar.

- Acesso: Sessão.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "preferred": "agency:11111111-1111-4111-8111-111111111111"
}
```

**Resposta `200`** — Decisão de contexto.

```json
{
  "decision": "enter",
  "context": {
    "type": "agency",
    "agencyId": "11111111-1111-4111-8111-111111111111",
    "agencyName": "Agência Exemplo",
    "roleKey": "admin",
    "roleName": "Admin",
    "isOwner": true
  }
}
```

**Erros:** `401 UNAUTHENTICATED` · `500 INTERNAL_ERROR`

#### `PUT /me/last-context`

Grava o último contexto usado.

- Acesso: Sessão.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "type": "agency",
  "agencyId": "11111111-1111-4111-8111-111111111111"
}
```

**Resposta `204`** — Preferência gravada.

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /clients/:clientId/onboarding/seen`

Marca o primeiro acesso ao portal do cliente.

- Acesso: Sessão + vínculo com o cliente.
- Permissão: —.

**Resposta `204`** — Registrado.

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

### agencies — Dados do contexto de agência, incluindo as permissões efetivas.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `GET` | `/agencies/:agencyId/me` | Sessão + vínculo com a agência | — | Devolve as permissões efetivas do contexto de agência |

#### `GET /agencies/:agencyId/me`

Devolve as permissões efetivas do contexto de agência.

- Acesso: Sessão + vínculo com a agência.
- Permissão: —.

**Resposta `200`** — Permissões efetivas.

```json
{
  "agencyId": "11111111-1111-4111-8111-111111111111",
  "agencyName": "Agência Exemplo",
  "isOwner": false,
  "role": {
    "key": "admin",
    "name": "Admin"
  },
  "permissions": [
    "cliente.visualizar",
    "colaborador.visualizar",
    "midia.enviar"
  ]
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

### clients — Cadastro do cliente da agência: carteira com triagem, criar, ler o detalhe com o resumo, editar e trocar a foto; agendar, desmarcar, arquivar e reativar o contrato; estudo de marca e personas; a conversa em thread entre a agência e o cliente, pelos dois lados; as leituras do próprio cliente no portal; e os acessos ao portal vistos pela agência.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `GET` | `/agencies/:agencyId/clients` | Sessão + vínculo com a agência | `cliente.visualizar` | Lista a carteira de clientes com ordem de triagem |
| `POST` | `/agencies/:agencyId/clients` | Sessão + vínculo com a agência | `cliente.cadastrar` | Cadastra um cliente |
| `GET` | `/agencies/:agencyId/clients/:clientId` | Sessão + vínculo com a agência | `cliente.visualizar` | Lê o detalhe do cliente com o resumo da aba Geral |
| `PATCH` | `/agencies/:agencyId/clients/:clientId` | Sessão + vínculo com a agência | `cliente.operar` | Edita o cadastro do cliente |
| `PUT` | `/agencies/:agencyId/clients/:clientId/photo` | Sessão + vínculo com a agência | `cliente.operar` | Envia a foto do cliente |
| `DELETE` | `/agencies/:agencyId/clients/:clientId/photo` | Sessão + vínculo com a agência | `cliente.operar` | Remove a foto do cliente |
| `PUT` | `/agencies/:agencyId/clients/:clientId/closing` | Sessão + vínculo com a agência | `cliente.arquivar` | Agenda o encerramento do contrato do cliente |
| `DELETE` | `/agencies/:agencyId/clients/:clientId/closing` | Sessão + vínculo com a agência | `cliente.arquivar` | Desmarca o encerramento agendado do cliente |
| `POST` | `/agencies/:agencyId/clients/:clientId/archive` | Sessão + vínculo com a agência | `cliente.arquivar` | Arquiva o cliente agora |
| `POST` | `/agencies/:agencyId/clients/:clientId/reactivate` | Sessão + vínculo com a agência | `cliente.arquivar` | Reativa um cliente arquivado |
| `GET` | `/agencies/:agencyId/clients/:clientId/brand-study` | Sessão + vínculo com a agência | `cliente.visualizar` | Lê o estudo de marca com as sete seções e as personas |
| `PUT` | `/agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey` | Sessão + vínculo com a agência | `cliente.operar` | Grava uma seção do estudo de marca (upsert) |
| `POST` | `/agencies/:agencyId/clients/:clientId/personas` | Sessão + vínculo com a agência | `cliente.operar` | Cria uma persona do cliente |
| `PATCH` | `/agencies/:agencyId/clients/:clientId/personas/:personaId` | Sessão + vínculo com a agência | `cliente.operar` | Edita uma persona |
| `POST` | `/agencies/:agencyId/clients/:clientId/personas/:personaId/archive` | Sessão + vínculo com a agência | `cliente.operar` | Arquiva uma persona |
| `POST` | `/agencies/:agencyId/clients/:clientId/personas/:personaId/unarchive` | Sessão + vínculo com a agência | `cliente.operar` | Desarquiva uma persona |
| `GET` | `/agencies/:agencyId/clients/:clientId/threads` | Sessão + vínculo com a agência | `cliente.visualizar` | Lista as conversas de um assunto do cliente |
| `POST` | `/agencies/:agencyId/clients/:clientId/threads` | Sessão + vínculo com a agência | `cliente.operar` | Abre uma conversa pela agência, com o primeiro comentário |
| `GET` | `/agencies/:agencyId/clients/:clientId/threads/:threadId/comments` | Sessão + vínculo com a agência | `cliente.visualizar` | Lista os comentários de uma conversa |
| `POST` | `/agencies/:agencyId/clients/:clientId/threads/:threadId/comments` | Sessão + vínculo com a agência | `cliente.operar` | Comenta uma conversa pela agência |
| `POST` | `/agencies/:agencyId/clients/:clientId/threads/:threadId/resolve` | Sessão + vínculo com a agência | `cliente.operar` | Resolve uma conversa |
| `GET` | `/agencies/:agencyId/clients/:clientId/members` | Sessão + vínculo com a agência | `cliente.convidar_usuario` | Lista as pessoas com acesso ao portal de um cliente |
| `POST` | `/agencies/:agencyId/clients/:clientId/members/:membershipId/remove` | Sessão + vínculo com a agência | `cliente.remover_usuario` | Remove uma pessoa do portal do cliente |
| `POST` | `/agencies/:agencyId/clients/:clientId/members/:membershipId/reactivate` | Sessão + vínculo com a agência | `cliente.remover_usuario` | Reativa uma pessoa do portal do cliente |
| `GET` | `/agencies/:agencyId/clients/:clientId/invitations` | Sessão + vínculo com a agência | `cliente.convidar_usuario` | Lista os convites de portal pendentes de um cliente |
| `GET` | `/clients/:clientId/threads` | Sessão + vínculo com o cliente | — | Lista as conversas de um assunto, no portal |
| `POST` | `/clients/:clientId/threads` | Sessão + vínculo com o cliente | — | Abre uma conversa pelo portal, com o primeiro comentário |
| `GET` | `/clients/:clientId/threads/:threadId/comments` | Sessão + vínculo com o cliente | — | Lista os comentários de uma conversa, no portal |
| `POST` | `/clients/:clientId/threads/:threadId/comments` | Sessão + vínculo com o cliente | — | Comenta uma conversa pelo portal |
| `GET` | `/clients/:clientId` | Sessão + vínculo com o cliente | — | Lê o cadastro do próprio cliente e o resumo do Início, no portal |
| `GET` | `/clients/:clientId/brand-study` | Sessão + vínculo com o cliente | — | Lê o estudo de marca, no portal |

#### `GET /agencies/:agencyId/clients`

Lista a carteira de clientes com ordem de triagem.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.visualizar`.

**Requisição** (`application/json`):

```json
{
  "page": 1,
  "pageSize": 20,
  "search": "padaria",
  "status": "active",
  "sort": "attention"
}
```

**Resposta `200`** — Página da carteira.

```json
{
  "data": [
    {
      "id": "77777777-7777-4777-8777-777777777777",
      "name": "Padaria Central",
      "photoUrl": null,
      "instagramHandle": "padariacentral",
      "status": "active",
      "closingDate": null,
      "threadsAwaitingAgency": 2,
      "pendingInvitations": 1
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients`

Cadastra um cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.cadastrar`.

**Requisição** (`application/json`):

```json
{
  "name": "Padaria Central"
}
```

**Resposta `201`** — Cliente criado.

```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "name": "Padaria Central",
  "status": "active",
  "photoUrl": null,
  "legalName": "Padaria Central Ltda",
  "taxId": "12345678000190",
  "segment": "Alimentação",
  "website": "https://padariacentral.exemplo.test",
  "instagramHandle": "padariacentral",
  "contactName": "Maria Souza",
  "contactPhone": "+55 11 90000-0000",
  "contactEmail": "maria@padariacentral.exemplo.test",
  "closingDate": null,
  "archivedAt": null
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_NAME_IN_USE` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/clients/:clientId`

Lê o detalhe do cliente com o resumo da aba Geral.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.visualizar`.

**Resposta `200`** — Detalhe do cliente.

```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "name": "Padaria Central",
  "status": "active",
  "photoUrl": null,
  "legalName": "Padaria Central Ltda",
  "taxId": "12345678000190",
  "segment": "Alimentação",
  "website": "https://padariacentral.exemplo.test",
  "instagramHandle": "padariacentral",
  "contactName": "Maria Souza",
  "contactPhone": "+55 11 90000-0000",
  "contactEmail": "maria@padariacentral.exemplo.test",
  "closingDate": null,
  "archivedAt": null,
  "summary": {
    "brandStudyFilled": 3,
    "threadsAwaitingAgency": 1,
    "threadsAnsweredByAgency": 2,
    "activePortalMembers": 3
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `PATCH /agencies/:agencyId/clients/:clientId`

Edita o cadastro do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Requisição** (`application/json`):

```json
{
  "taxId": "12.345.678/0001-90",
  "instagramHandle": "@padariacentral"
}
```

**Resposta `200`** — Cliente atualizado.

```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "name": "Padaria Central",
  "status": "active",
  "photoUrl": null,
  "legalName": "Padaria Central Ltda",
  "taxId": "12345678000190",
  "segment": "Alimentação",
  "website": "https://padariacentral.exemplo.test",
  "instagramHandle": "padariacentral",
  "contactName": "Maria Souza",
  "contactPhone": "+55 11 90000-0000",
  "contactEmail": "maria@padariacentral.exemplo.test",
  "closingDate": null,
  "archivedAt": null
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 CLIENT_NAME_IN_USE` · `500 INTERNAL_ERROR`

#### `PUT /agencies/:agencyId/clients/:clientId/photo`

Envia a foto do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Requisição** (`application/json`):

```json
{
  "imageBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
}
```

**Resposta `200`** — Foto atualizada.

```json
{
  "photoUrl": "https://storage.exemplo.test/arquivo.png?assinatura=ficticia"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `413 PAYLOAD_TOO_LARGE` · `415 UNSUPPORTED_MEDIA_TYPE` · `429 RATE_LIMITED` · `500 INTERNAL_ERROR`

#### `DELETE /agencies/:agencyId/clients/:clientId/photo`

Remove a foto do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Resposta `204`** — Foto removida.

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `500 INTERNAL_ERROR`

#### `PUT /agencies/:agencyId/clients/:clientId/closing`

Agenda o encerramento do contrato do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.arquivar`.

**Requisição** (`application/json`):

```json
{
  "closingDate": "2026-12-31"
}
```

**Resposta `200`** — Cliente com a data de encerramento.

```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "name": "Padaria Central",
  "status": "active",
  "photoUrl": null,
  "legalName": "Padaria Central Ltda",
  "taxId": "12345678000190",
  "segment": "Alimentação",
  "website": "https://padariacentral.exemplo.test",
  "instagramHandle": "padariacentral",
  "contactName": "Maria Souza",
  "contactPhone": "+55 11 90000-0000",
  "contactEmail": "maria@padariacentral.exemplo.test",
  "closingDate": "2026-12-31",
  "archivedAt": null
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 TRY_AGAIN` · `500 INTERNAL_ERROR`

#### `DELETE /agencies/:agencyId/clients/:clientId/closing`

Desmarca o encerramento agendado do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.arquivar`.

**Resposta `200`** — Cliente sem data de encerramento.

```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "name": "Padaria Central",
  "status": "active",
  "photoUrl": null,
  "legalName": "Padaria Central Ltda",
  "taxId": "12345678000190",
  "segment": "Alimentação",
  "website": "https://padariacentral.exemplo.test",
  "instagramHandle": "padariacentral",
  "contactName": "Maria Souza",
  "contactPhone": "+55 11 90000-0000",
  "contactEmail": "maria@padariacentral.exemplo.test",
  "closingDate": null,
  "archivedAt": null
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 CLOSING_DATE_NOT_SET` · `409 TRY_AGAIN` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/archive`

Arquiva o cliente agora.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.arquivar`.

**Resposta `200`** — Cliente arquivado.

```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "name": "Padaria Central",
  "status": "archived",
  "photoUrl": null,
  "legalName": "Padaria Central Ltda",
  "taxId": "12345678000190",
  "segment": "Alimentação",
  "website": "https://padariacentral.exemplo.test",
  "instagramHandle": "padariacentral",
  "contactName": "Maria Souza",
  "contactPhone": "+55 11 90000-0000",
  "contactEmail": "maria@padariacentral.exemplo.test",
  "closingDate": null,
  "archivedAt": "2026-10-07T12:00:00.000Z"
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 TRY_AGAIN` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/reactivate`

Reativa um cliente arquivado.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.arquivar`.

**Resposta `200`** — Cliente ativo.

```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "name": "Padaria Central",
  "status": "active",
  "photoUrl": null,
  "legalName": "Padaria Central Ltda",
  "taxId": "12345678000190",
  "segment": "Alimentação",
  "website": "https://padariacentral.exemplo.test",
  "instagramHandle": "padariacentral",
  "contactName": "Maria Souza",
  "contactPhone": "+55 11 90000-0000",
  "contactEmail": "maria@padariacentral.exemplo.test",
  "closingDate": null,
  "archivedAt": null
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_NAME_IN_USE` · `409 CLIENT_NOT_ARCHIVED` · `409 TRY_AGAIN` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/clients/:clientId/brand-study`

Lê o estudo de marca com as sete seções e as personas.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.visualizar`.

**Resposta `200`** — Estudo de marca.

```json
{
  "filled": 3,
  "sections": [
    {
      "key": "branding",
      "body": "Marca acolhedora.",
      "colors": null,
      "archetype": null,
      "updatedBy": {
        "id": "55555555-5555-4555-8555-555555555555",
        "name": "Dono da Agência"
      },
      "updatedAt": "2026-09-30T12:00:00.000Z"
    },
    {
      "key": "tone_of_voice",
      "body": null,
      "colors": null,
      "archetype": null,
      "updatedBy": null,
      "updatedAt": null
    },
    {
      "key": "colors",
      "body": null,
      "colors": [
        {
          "name": "Vinho",
          "hex": "#7A1F2B"
        }
      ],
      "archetype": null,
      "updatedBy": {
        "id": "55555555-5555-4555-8555-555555555555",
        "name": "Dono da Agência"
      },
      "updatedAt": "2026-09-30T12:00:00.000Z"
    },
    {
      "key": "positioning",
      "body": null,
      "colors": null,
      "archetype": null,
      "updatedBy": null,
      "updatedAt": null
    },
    {
      "key": "archetype",
      "body": null,
      "colors": null,
      "archetype": "caregiver",
      "updatedBy": null,
      "updatedAt": null
    },
    {
      "key": "personas",
      "body": null,
      "colors": null,
      "archetype": null,
      "updatedBy": null,
      "updatedAt": null
    },
    {
      "key": "observations",
      "body": null,
      "colors": null,
      "archetype": null,
      "updatedBy": null,
      "updatedAt": null
    }
  ],
  "personas": [
    {
      "id": "88888888-8888-4888-8888-888888888888",
      "name": "Dona Maria",
      "description": "Dona de casa, 58 anos.",
      "pains": "Pouco tempo para pesquisar.",
      "desires": "Reconhecimento da comunidade.",
      "objections": "Preço acima do esperado.",
      "status": "active",
      "updatedBy": {
        "id": "55555555-5555-4555-8555-555555555555",
        "name": "Dono da Agência"
      },
      "updatedAt": "2026-09-30T12:00:00.000Z"
    }
  ]
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `PUT /agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey`

Grava uma seção do estudo de marca (upsert).

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Requisição** (`application/json`):

```json
{
  "body": "Marca acolhedora."
}
```

**Resposta `200`** — Seção gravada.

```json
{
  "key": "colors",
  "body": null,
  "colors": [
    {
      "name": "Vinho",
      "hex": "#7A1F2B"
    }
  ],
  "archetype": null,
  "updatedBy": {
    "id": "55555555-5555-4555-8555-555555555555",
    "name": "Dono da Agência"
  },
  "updatedAt": "2026-09-30T12:00:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/personas`

Cria uma persona do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Requisição** (`application/json`):

```json
{
  "name": "Dona Maria",
  "description": "Dona de casa, 58 anos."
}
```

**Resposta `201`** — Persona criada.

```json
{
  "id": "88888888-8888-4888-8888-888888888888",
  "name": "Dona Maria",
  "description": "Dona de casa, 58 anos.",
  "pains": "Pouco tempo para pesquisar.",
  "desires": "Reconhecimento da comunidade.",
  "objections": "Preço acima do esperado.",
  "status": "active",
  "updatedBy": {
    "id": "55555555-5555-4555-8555-555555555555",
    "name": "Dono da Agência"
  },
  "updatedAt": "2026-09-30T12:00:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `500 INTERNAL_ERROR`

#### `PATCH /agencies/:agencyId/clients/:clientId/personas/:personaId`

Edita uma persona.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Requisição** (`application/json`):

```json
{
  "name": "Dona Maria",
  "desires": "Reconhecimento da comunidade."
}
```

**Resposta `200`** — Persona atualizada.

```json
{
  "id": "88888888-8888-4888-8888-888888888888",
  "name": "Dona Maria",
  "description": "Dona de casa, 58 anos.",
  "pains": "Pouco tempo para pesquisar.",
  "desires": "Reconhecimento da comunidade.",
  "objections": "Preço acima do esperado.",
  "status": "active",
  "updatedBy": {
    "id": "55555555-5555-4555-8555-555555555555",
    "name": "Dono da Agência"
  },
  "updatedAt": "2026-09-30T12:00:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/personas/:personaId/archive`

Arquiva uma persona.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Resposta `200`** — Persona arquivada.

```json
{
  "id": "88888888-8888-4888-8888-888888888888",
  "name": "Dona Maria",
  "description": "Dona de casa, 58 anos.",
  "pains": "Pouco tempo para pesquisar.",
  "desires": "Reconhecimento da comunidade.",
  "objections": "Preço acima do esperado.",
  "status": "archived",
  "updatedBy": {
    "id": "55555555-5555-4555-8555-555555555555",
    "name": "Dono da Agência"
  },
  "updatedAt": "2026-09-30T12:00:00.000Z"
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/personas/:personaId/unarchive`

Desarquiva uma persona.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Resposta `200`** — Persona reativada.

```json
{
  "id": "88888888-8888-4888-8888-888888888888",
  "name": "Dona Maria",
  "description": "Dona de casa, 58 anos.",
  "pains": "Pouco tempo para pesquisar.",
  "desires": "Reconhecimento da comunidade.",
  "objections": "Preço acima do esperado.",
  "status": "active",
  "updatedBy": {
    "id": "55555555-5555-4555-8555-555555555555",
    "name": "Dono da Agência"
  },
  "updatedAt": "2026-09-30T12:00:00.000Z"
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/clients/:clientId/threads`

Lista as conversas de um assunto do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.visualizar`.

**Requisição** (`application/json`):

```json
{
  "sectionKey": "tone_of_voice",
  "state": "open"
}
```

**Resposta `200`** — Página de conversas.

```json
{
  "data": [
    {
      "id": "99999999-9999-4999-8999-999999999999",
      "subject": {
        "sectionKey": "tone_of_voice"
      },
      "state": "open",
      "openedBy": {
        "name": "Ana, da Padaria Central",
        "side": "client"
      },
      "lastComment": {
        "side": "client",
        "at": "2026-10-07T12:00:00.000Z",
        "excerpt": "Podemos aproximar o tom de voz do que usamos nas redes?"
      },
      "commentCount": 1,
      "resolvedBy": null,
      "resolvedAt": null
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/threads`

Abre uma conversa pela agência, com o primeiro comentário.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Requisição** (`application/json`):

```json
{
  "subject": {
    "sectionKey": "tone_of_voice"
  },
  "body": "Vamos revisar o tom de voz com o time?"
}
```

**Resposta `201`** — Conversa aberta.

```json
{
  "thread": {
    "id": "99999999-9999-4999-8999-999999999999",
    "subject": {
      "sectionKey": "tone_of_voice"
    },
    "state": "open",
    "openedBy": {
      "name": "Dono da Agência",
      "side": "agency"
    },
    "lastComment": {
      "side": "agency",
      "at": "2026-10-07T12:00:00.000Z",
      "excerpt": "Vamos revisar o tom de voz com o time?"
    },
    "commentCount": 1,
    "resolvedBy": null,
    "resolvedAt": null
  },
  "comment": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "body": "Vamos revisar o tom de voz com o time?",
    "side": "agency",
    "author": {
      "name": "Dono da Agência",
      "photoUrl": null
    },
    "createdAt": "2026-10-07T12:00:00.000Z"
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 PERSONA_ARCHIVED` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/clients/:clientId/threads/:threadId/comments`

Lista os comentários de uma conversa.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.visualizar`.

**Requisição** (`application/json`):

```json
{
  "page": 1
}
```

**Resposta `200`** — Página de comentários.

```json
{
  "data": [
    {
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "body": "Podemos aproximar o tom de voz do que usamos nas redes?",
      "side": "client",
      "author": {
        "name": "Ana, da Padaria Central",
        "photoUrl": null
      },
      "createdAt": "2026-10-07T12:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 50,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/threads/:threadId/comments`

Comenta uma conversa pela agência.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Requisição** (`application/json`):

```json
{
  "body": "Combinado, ajustamos esta semana."
}
```

**Resposta `201`** — Comentário gravado.

```json
{
  "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "body": "Podemos aproximar o tom de voz do que usamos nas redes?",
  "side": "agency",
  "author": {
    "name": "Ana, da Padaria Central",
    "photoUrl": null
  },
  "createdAt": "2026-10-07T12:00:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 PERSONA_ARCHIVED` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/threads/:threadId/resolve`

Resolve uma conversa.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.operar`.

**Resposta `200`** — Conversa resolvida.

```json
{
  "id": "99999999-9999-4999-8999-999999999999",
  "subject": {
    "sectionKey": "tone_of_voice"
  },
  "state": "resolved",
  "openedBy": {
    "name": "Ana, da Padaria Central",
    "side": "client"
  },
  "lastComment": {
    "side": "client",
    "at": "2026-10-07T12:00:00.000Z",
    "excerpt": "Podemos aproximar o tom de voz do que usamos nas redes?"
  },
  "commentCount": 1,
  "resolvedBy": {
    "name": "Dono da Agência"
  },
  "resolvedAt": "2026-10-07T13:00:00.000Z"
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 PERSONA_ARCHIVED` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/clients/:clientId/members`

Lista as pessoas com acesso ao portal de um cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.convidar_usuario`.

**Requisição** (`application/json`):

```json
{
  "status": "active"
}
```

**Resposta `200`** — Página de pessoas do portal.

```json
{
  "data": [
    {
      "membershipId": "22222222-2222-4222-8222-222222222222",
      "name": "Maria Souza",
      "email": "maria@padariacentral.exemplo.test",
      "status": "active",
      "since": "2026-09-02T12:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/members/:membershipId/remove`

Remove uma pessoa do portal do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.remover_usuario`.

**Resposta `200`** — Vínculo removido.

```json
{
  "membershipId": "22222222-2222-4222-8222-222222222222",
  "name": "Maria Souza",
  "email": "maria@padariacentral.exemplo.test",
  "status": "removed",
  "since": "2026-09-02T12:00:00.000Z"
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/members/:membershipId/reactivate`

Reativa uma pessoa do portal do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.remover_usuario`.

**Resposta `200`** — Vínculo reativado.

```json
{
  "membershipId": "22222222-2222-4222-8222-222222222222",
  "name": "Maria Souza",
  "email": "maria@padariacentral.exemplo.test",
  "status": "active",
  "since": "2026-09-02T12:00:00.000Z"
}
```

**Erros:** `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/clients/:clientId/invitations`

Lista os convites de portal pendentes de um cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `cliente.convidar_usuario`.

**Requisição** (`application/json`):

```json
{
  "page": 1
}
```

**Resposta `200`** — Página de convites pendentes.

```json
{
  "data": [
    {
      "invitationId": "33333333-3333-4333-8333-333333333333",
      "email": "joao@padariacentral.exemplo.test",
      "expiresAt": "2026-10-14T12:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `GET /clients/:clientId/threads`

Lista as conversas de um assunto, no portal.

- Acesso: Sessão + vínculo com o cliente.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "sectionKey": "tone_of_voice"
}
```

**Resposta `200`** — Página de conversas.

```json
{
  "data": [
    {
      "id": "99999999-9999-4999-8999-999999999999",
      "subject": {
        "sectionKey": "tone_of_voice"
      },
      "state": "open",
      "openedBy": {
        "name": "Ana, da Padaria Central",
        "side": "client"
      },
      "lastComment": {
        "side": "client",
        "at": "2026-10-07T12:00:00.000Z",
        "excerpt": "Podemos aproximar o tom de voz do que usamos nas redes?"
      },
      "commentCount": 1,
      "resolvedBy": null,
      "resolvedAt": null
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /clients/:clientId/threads`

Abre uma conversa pelo portal, com o primeiro comentário.

- Acesso: Sessão + vínculo com o cliente.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "subject": {
    "sectionKey": "tone_of_voice"
  },
  "body": "Podemos aproximar o tom de voz do que usamos nas redes?"
}
```

**Resposta `201`** — Conversa aberta.

```json
{
  "thread": {
    "id": "99999999-9999-4999-8999-999999999999",
    "subject": {
      "sectionKey": "tone_of_voice"
    },
    "state": "open",
    "openedBy": {
      "name": "Ana, da Padaria Central",
      "side": "client"
    },
    "lastComment": {
      "side": "client",
      "at": "2026-10-07T12:00:00.000Z",
      "excerpt": "Podemos aproximar o tom de voz do que usamos nas redes?"
    },
    "commentCount": 1,
    "resolvedBy": null,
    "resolvedAt": null
  },
  "comment": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "body": "Podemos aproximar o tom de voz do que usamos nas redes?",
    "side": "client",
    "author": {
      "name": "Ana, da Padaria Central",
      "photoUrl": null
    },
    "createdAt": "2026-10-07T12:00:00.000Z"
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `404 NOT_FOUND` · `409 SECTION_NOT_FILLED` · `500 INTERNAL_ERROR`

#### `GET /clients/:clientId/threads/:threadId/comments`

Lista os comentários de uma conversa, no portal.

- Acesso: Sessão + vínculo com o cliente.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "page": 1
}
```

**Resposta `200`** — Página de comentários.

```json
{
  "data": [
    {
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "body": "Podemos aproximar o tom de voz do que usamos nas redes?",
      "side": "client",
      "author": {
        "name": "Ana, da Padaria Central",
        "photoUrl": null
      },
      "createdAt": "2026-10-07T12:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 50,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /clients/:clientId/threads/:threadId/comments`

Comenta uma conversa pelo portal.

- Acesso: Sessão + vínculo com o cliente.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "body": "Obrigada, ficou melhor assim."
}
```

**Resposta `201`** — Comentário gravado.

```json
{
  "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "body": "Podemos aproximar o tom de voz do que usamos nas redes?",
  "side": "client",
  "author": {
    "name": "Ana, da Padaria Central",
    "photoUrl": null
  },
  "createdAt": "2026-10-07T12:00:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `GET /clients/:clientId`

Lê o cadastro do próprio cliente e o resumo do Início, no portal.

- Acesso: Sessão + vínculo com o cliente.
- Permissão: —.

**Resposta `200`** — Cadastro do cliente e resumo do Início.

```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "name": "Padaria Central",
  "status": "active",
  "photoUrl": null,
  "legalName": "Padaria Central Ltda",
  "taxId": "12345678000190",
  "segment": "Alimentação",
  "website": "https://padariacentral.exemplo.test",
  "instagramHandle": "padariacentral",
  "contactName": "Maria Souza",
  "contactPhone": "+55 11 90000-0000",
  "contactEmail": "maria@padariacentral.exemplo.test",
  "closingDate": null,
  "archivedAt": null,
  "agencyName": "Agência Exemplo",
  "onboardingSeenAt": "2026-10-01T12:00:00.000Z",
  "home": {
    "threadsAnsweredByAgency": 2,
    "brandStudyFilled": 3
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `GET /clients/:clientId/brand-study`

Lê o estudo de marca, no portal.

- Acesso: Sessão + vínculo com o cliente.
- Permissão: —.

**Resposta `200`** — Estudo de marca.

```json
{
  "filled": 3,
  "sections": [
    {
      "key": "branding",
      "body": "Marca acolhedora.",
      "colors": null,
      "archetype": null,
      "updatedAt": "2026-09-30T12:00:00.000Z"
    },
    {
      "key": "tone_of_voice",
      "body": null,
      "colors": null,
      "archetype": null,
      "updatedAt": null
    },
    {
      "key": "colors",
      "body": null,
      "colors": [
        {
          "name": "Vinho",
          "hex": "#7A1F2B"
        }
      ],
      "archetype": null,
      "updatedAt": "2026-09-30T12:00:00.000Z"
    },
    {
      "key": "positioning",
      "body": null,
      "colors": null,
      "archetype": null,
      "updatedAt": null
    },
    {
      "key": "archetype",
      "body": null,
      "colors": null,
      "archetype": "caregiver",
      "updatedAt": "2026-09-30T12:00:00.000Z"
    },
    {
      "key": "personas",
      "body": null,
      "colors": null,
      "archetype": null,
      "updatedAt": null
    },
    {
      "key": "observations",
      "body": null,
      "colors": null,
      "archetype": null,
      "updatedAt": null
    }
  ],
  "personas": [
    {
      "id": "88888888-8888-4888-8888-888888888888",
      "name": "Dona Maria",
      "description": "Dona de casa, 58 anos.",
      "pains": "Pouco tempo para pesquisar.",
      "desires": "Reconhecimento da comunidade.",
      "objections": "Preço acima do esperado.",
      "status": "active",
      "updatedAt": "2026-09-30T12:00:00.000Z"
    }
  ]
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

### collaborators — A equipe da agência: listagem com paginação, busca e filtros, detalhe, alteração de cargo e papel, remoção e reativação.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `GET` | `/agencies/:agencyId/collaborators` | Sessão + vínculo com a agência | `colaborador.visualizar` | Lista a equipe da agência |
| `GET` | `/agencies/:agencyId/collaborators/:membershipId` | Sessão + vínculo com a agência | `colaborador.visualizar` | Devolve um colaborador da agência |
| `PATCH` | `/agencies/:agencyId/collaborators/:membershipId` | Sessão + vínculo com a agência | `colaborador.alterar_funcao` ou `colaborador.alterar_papel` | Altera o cargo e/ou o papel de um colaborador |
| `POST` | `/agencies/:agencyId/collaborators/:membershipId/remove` | Sessão + vínculo com a agência | `colaborador.remover` | Remove um colaborador do quadro |
| `POST` | `/agencies/:agencyId/collaborators/:membershipId/reactivate` | Sessão + vínculo com a agência | `colaborador.alterar_papel` | Reativa um colaborador removido |
| `GET` | `/agencies/:agencyId/collaborators/job-titles` | Sessão + vínculo com a agência | `colaborador.visualizar` | Lista os cargos que existem na agência |
| `GET` | `/agencies/:agencyId/roles` | Sessão + vínculo com a agência | `colaborador.convidar` ou `colaborador.alterar_papel` | Lista os papéis atribuíveis na agência |

#### `GET /agencies/:agencyId/collaborators`

Lista a equipe da agência.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `colaborador.visualizar`.

**Requisição** (`application/json`):

```json
{
  "page": 1,
  "pageSize": 24,
  "q": "camila",
  "role": "account_manager",
  "status": "active"
}
```

**Resposta `200`** — Página da equipe.

```json
{
  "data": [
    {
      "membershipId": "22222222-2222-4222-8222-222222222222",
      "name": "Camila Nogueira",
      "email": "camila@exemplo.test",
      "photoUrl": "https://storage.exemplo.test/arquivo.png?assinatura=ficticia",
      "jobTitle": "Gestora de contas",
      "role": {
        "key": "account_manager",
        "name": "Gestor de conta"
      },
      "isOwner": false,
      "isSelf": false,
      "status": "active",
      "joinedAt": "2026-03-12T12:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 24,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/collaborators/:membershipId`

Devolve um colaborador da agência.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `colaborador.visualizar`.

**Resposta `200`** — O colaborador pedido.

```json
{
  "membershipId": "22222222-2222-4222-8222-222222222222",
  "name": "Camila Nogueira",
  "email": "camila@exemplo.test",
  "photoUrl": "https://storage.exemplo.test/arquivo.png?assinatura=ficticia",
  "jobTitle": "Gestora de contas",
  "role": {
    "key": "account_manager",
    "name": "Gestor de conta"
  },
  "isOwner": false,
  "isSelf": false,
  "status": "active",
  "joinedAt": "2026-03-12T12:00:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `PATCH /agencies/:agencyId/collaborators/:membershipId`

Altera o cargo e/ou o papel de um colaborador.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `colaborador.alterar_funcao` ou `colaborador.alterar_papel`.

**Requisição** (`application/json`):

```json
{
  "jobTitle": "Editor de Vídeo",
  "roleId": "66666666-6666-4666-8666-666666666666"
}
```

**Resposta `200`** — O colaborador atualizado.

```json
{
  "membershipId": "22222222-2222-4222-8222-222222222222",
  "name": "Camila Nogueira",
  "email": "camila@exemplo.test",
  "photoUrl": "https://storage.exemplo.test/arquivo.png?assinatura=ficticia",
  "jobTitle": "Editor de Vídeo",
  "role": {
    "key": "production",
    "name": "Produção"
  },
  "isOwner": false,
  "isSelf": false,
  "status": "active",
  "joinedAt": "2026-03-12T12:00:00.000Z"
}
```

**Erros:** `400 INVALID_ROLE` · `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/collaborators/:membershipId/remove`

Remove um colaborador do quadro.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `colaborador.remover`.

**Resposta `200`** — O colaborador removido.

```json
{
  "membershipId": "22222222-2222-4222-8222-222222222222",
  "name": "Camila Nogueira",
  "email": "camila@exemplo.test",
  "photoUrl": null,
  "jobTitle": "Editor de Vídeo",
  "role": {
    "key": "production",
    "name": "Produção"
  },
  "isOwner": false,
  "isSelf": false,
  "status": "removed",
  "joinedAt": "2026-03-12T12:00:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 COLLABORATOR_ALREADY_REMOVED` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/collaborators/:membershipId/reactivate`

Reativa um colaborador removido.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `colaborador.alterar_papel`.

**Requisição** (`application/json`):

```json
{
  "roleId": "66666666-6666-4666-8666-666666666666"
}
```

**Resposta `200`** — O colaborador reativado.

```json
{
  "membershipId": "22222222-2222-4222-8222-222222222222",
  "name": "Camila Nogueira",
  "email": "camila@exemplo.test",
  "photoUrl": null,
  "jobTitle": "Editor de Vídeo",
  "role": {
    "key": "production",
    "name": "Produção"
  },
  "isOwner": false,
  "isSelf": false,
  "status": "active",
  "joinedAt": "2026-03-12T12:00:00.000Z"
}
```

**Erros:** `400 INVALID_ROLE` · `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 COLLABORATOR_NOT_REMOVED` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/collaborators/job-titles`

Lista os cargos que existem na agência.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `colaborador.visualizar`.

**Resposta `200`** — Cargos existentes na agência.

```json
{
  "data": [
    "Editor de Vídeo",
    "Gestora de contas",
    "Designer"
  ]
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/roles`

Lista os papéis atribuíveis na agência.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `colaborador.convidar` ou `colaborador.alterar_papel`.

**Resposta `200`** — Papéis atribuíveis na agência.

```json
{
  "data": [
    {
      "id": "66666666-6666-4666-8666-666666666666",
      "key": "admin",
      "name": "Admin"
    },
    {
      "id": "66666666-6666-4666-8666-666666666667",
      "key": "account_manager",
      "name": "Gestor de conta"
    }
  ]
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

### media — Upload direto ao armazenamento, confirmação e URLs assinadas de mídia; as pastas de mídia de um cliente, a listagem do que há nelas e a remoção.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `POST` | `/agencies/:agencyId/media/uploads` | Sessão + vínculo com a agência | `midia.enviar` ou `conteudo.operar` | Inicia um upload de mídia |
| `POST` | `/agencies/:agencyId/media/uploads/:assetId/parts` | Sessão + vínculo com a agência | `midia.enviar` ou `conteudo.operar` | Pede URLs assinadas de partes do multipart |
| `POST` | `/agencies/:agencyId/media/uploads/:assetId/complete` | Sessão + vínculo com a agência | `midia.enviar` ou `conteudo.operar` | Confirma o upload e valida o objeto |
| `GET` | `/agencies/:agencyId/media/:assetId/download-url` | Sessão + vínculo com a agência | `midia.enviar` | Emite uma URL assinada de leitura |
| `GET` | `/agencies/:agencyId/clients/:clientId/media-folders` | Sessão + vínculo com a agência | `conteudo.visualizar` | Lista as pastas de mídia de um cliente |
| `POST` | `/agencies/:agencyId/clients/:clientId/media-folders` | Sessão + vínculo com a agência | `conteudo.operar` | Cria uma pasta de mídia do cliente |
| `GET` | `/agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets` | Sessão + vínculo com a agência | `conteudo.visualizar` | Lista as mídias de uma pasta |
| `POST` | `/agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets/:assetId/remove` | Sessão + vínculo com a agência | `conteudo.operar` | Remove uma mídia da pasta |

#### `POST /agencies/:agencyId/media/uploads`

Inicia um upload de mídia.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `midia.enviar` ou `conteudo.operar`.

**Requisição** (`application/json`):

```json
{
  "fileName": "foto.png",
  "contentType": "image/png",
  "declaredSizeBytes": 1048576
}
```

**Resposta `201`** — Upload iniciado.

```json
{
  "assetId": "44444444-4444-4444-8444-444444444444",
  "objectKey": "11111111-1111-4111-8111-111111111111/44444444-4444-4444-8444-444444444444/original.png",
  "category": "image",
  "upload": {
    "type": "single",
    "url": "https://storage.exemplo.test/arquivo.png?assinatura=ficticia",
    "expiresAt": "2026-09-29T12:15:00.000Z"
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 QUOTA_EXCEEDED` · `409 TRY_AGAIN` · `413 PAYLOAD_TOO_LARGE` · `415 UNSUPPORTED_MEDIA_TYPE` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/media/uploads/:assetId/parts`

Pede URLs assinadas de partes do multipart.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `midia.enviar` ou `conteudo.operar`.

**Requisição** (`application/json`):

```json
{
  "partNumbers": [
    1,
    2
  ]
}
```

**Resposta `200`** — URLs assinadas das partes.

```json
{
  "parts": [
    {
      "partNumber": 1,
      "url": "https://storage.exemplo.test/arquivo.png?assinatura=ficticia"
    }
  ],
  "expiresAt": "2026-09-29T12:15:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 UPLOAD_NOT_PENDING` · `413 PAYLOAD_TOO_LARGE` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/media/uploads/:assetId/complete`

Confirma o upload e valida o objeto.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `midia.enviar` ou `conteudo.operar`.

**Requisição** (`application/json`):

```json
{
  "parts": [
    {
      "partNumber": 1,
      "eTag": "\"exemplo-de-etag\""
    }
  ]
}
```

**Resposta `200`** — Upload confirmado.

```json
{
  "assetId": "44444444-4444-4444-8444-444444444444",
  "status": "confirmed",
  "sizeBytes": 1048576,
  "contentType": "image/png"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 QUOTA_EXCEEDED` · `409 UPLOAD_NOT_PENDING` · `413 PAYLOAD_TOO_LARGE` · `422 UPLOAD_REJECTED` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/media/:assetId/download-url`

Emite uma URL assinada de leitura.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `midia.enviar`.

**Requisição** (`application/json`):

```json
{
  "variant": "original"
}
```

**Resposta `200`** — URL assinada.

```json
{
  "url": "https://storage.exemplo.test/arquivo.png?assinatura=ficticia",
  "expiresAt": "2026-09-29T12:05:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 VARIANT_NOT_READY` · `409 VARIANT_PROCESSING_FAILED` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/clients/:clientId/media-folders`

Lista as pastas de mídia de um cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `conteudo.visualizar`.

**Requisição** (`application/json`):

```json
{
  "page": 1
}
```

**Resposta `200`** — Página de pastas.

```json
{
  "data": [
    {
      "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "parentId": null,
      "name": "Vídeos",
      "isDefault": true,
      "createdAt": "2026-10-07T12:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 100,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/media-folders`

Cria uma pasta de mídia do cliente.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `conteudo.operar`.

**Requisição** (`application/json`):

```json
{
  "name": "Lançamento de outubro",
  "parentId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
}
```

**Resposta `201`** — Pasta criada.

```json
{
  "id": "12121212-1212-4121-8121-121212121212",
  "parentId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "name": "Lançamento de outubro",
  "isDefault": false,
  "createdAt": "2026-10-07T12:00:00.000Z"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 TRY_AGAIN` · `413 PAYLOAD_TOO_LARGE` · `500 INTERNAL_ERROR`

#### `GET /agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets`

Lista as mídias de uma pasta.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `conteudo.visualizar`.

**Requisição** (`application/json`):

```json
{
  "page": 1
}
```

**Resposta `200`** — Página de mídias.

```json
{
  "data": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "category": "image",
      "contentType": "image/png",
      "sizeBytes": 1048576,
      "videoProcessingStatus": "not_applicable",
      "createdAt": "2026-10-07T12:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 48,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `500 INTERNAL_ERROR`

#### `POST /agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets/:assetId/remove`

Remove uma mídia da pasta.

- Acesso: Sessão + vínculo com a agência.
- Permissão: `conteudo.operar`.

**Resposta `200`** — Mídia removida da pasta.

```json
{
  "assetId": "44444444-4444-4444-8444-444444444444",
  "removed": true
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 CLIENT_ARCHIVED` · `409 MEDIA_IN_USE` · `409 TRY_AGAIN` · `500 INTERNAL_ERROR`

### profile — Edição do próprio nome e da própria foto de perfil.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `PATCH` | `/me/profile` | Sessão | — | Altera o nome da própria pessoa |
| `POST` | `/me/photo` | Sessão | — | Envia a própria foto de perfil |

#### `PATCH /me/profile`

Altera o nome da própria pessoa.

- Acesso: Sessão.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "name": "Novo Nome"
}
```

**Resposta `200`** — Nome atualizado.

```json
{
  "id": "55555555-5555-4555-8555-555555555555",
  "name": "Novo Nome"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `413 PAYLOAD_TOO_LARGE` · `500 INTERNAL_ERROR`

#### `POST /me/photo`

Envia a própria foto de perfil.

- Acesso: Sessão.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "imageBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
}
```

**Resposta `200`** — Foto atualizada.

```json
{
  "imageUrl": "https://storage.exemplo.test/arquivo.png?assinatura=ficticia"
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `413 PAYLOAD_TOO_LARGE` · `415 UNSUPPORTED_MEDIA_TYPE` · `500 INTERNAL_ERROR`

### legal — Versão dos Termos e da Privacidade que a conta aceitou, e o aceite de um documento por vez.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `GET` | `/me/legal-acceptances` | Sessão | — | Consulta a versão aceita dos Termos e da Privacidade |
| `POST` | `/me/legal-acceptances` | Sessão | — | Aceita um documento legal, na versão em vigor |

#### `GET /me/legal-acceptances`

Consulta a versão aceita dos Termos e da Privacidade.

- Acesso: Sessão.
- Permissão: —.

**Resposta `200`** — Situação dos dois documentos.

```json
{
  "documents": [
    {
      "document": "terms",
      "currentVersion": "2026-01-01",
      "acceptedVersion": "2026-01-01",
      "pending": false
    },
    {
      "document": "privacy",
      "currentVersion": "2026-10-01",
      "acceptedVersion": "2026-02-01",
      "pending": true
    }
  ]
}
```

**Erros:** `401 UNAUTHENTICATED` · `500 INTERNAL_ERROR`

#### `POST /me/legal-acceptances`

Aceita um documento legal, na versão em vigor.

- Acesso: Sessão.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "document": "privacy"
}
```

**Resposta `200`** — Situação dos dois documentos depois do aceite.

```json
{
  "documents": [
    {
      "document": "terms",
      "currentVersion": "2026-01-01",
      "acceptedVersion": "2026-01-01",
      "pending": false
    },
    {
      "document": "privacy",
      "currentVersion": "2026-10-01",
      "acceptedVersion": "2026-02-01",
      "pending": true
    }
  ]
}
```

**Erros:** `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `413 PAYLOAD_TOO_LARGE` · `500 INTERNAL_ERROR`

### email-change — Pedido de troca do e-mail da conta, aprovado pela operação, e a confirmação pelo link enviado ao e-mail novo.

| método | rota | acesso | permissão | o que faz |
|---|---|---|---|---|
| `POST` | `/me/email-change` | Sessão | — | Pede a troca do e-mail da própria conta |
| `POST` | `/email-change/confirm` | Pública, pelo token do link | — | Confirma a troca de e-mail pelo link enviado ao e-mail novo |

#### `POST /me/email-change`

Pede a troca do e-mail da própria conta.

- Acesso: Sessão.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "newEmail": "novo.endereco@exemplo.test",
  "currentPassword": "<senha-do-exemplo>"
}
```

**Resposta `202`** — Pedido registrado; o endereço atual foi avisado.

```json
{}
```

**Erros:** `400 SAME_EMAIL` · `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` · `403 CSRF_REJECTED` · `403 INVALID_PASSWORD` · `409 TRY_AGAIN` · `413 PAYLOAD_TOO_LARGE` · `429 RATE_LIMITED` · `500 INTERNAL_ERROR`

#### `POST /email-change/confirm`

Confirma a troca de e-mail pelo link enviado ao e-mail novo.

- Acesso: Pública, pelo token do link.
- Permissão: —.

**Requisição** (`application/json`):

```json
{
  "token": "<token-do-link>"
}
```

**Resposta `200`** — E-mail trocado e sessões encerradas.

```json
{}
```

**Erros:** `400 INVALID_LINK` · `400 VALIDATION_ERROR` · `403 CSRF_REJECTED` · `409 TRY_AGAIN` · `413 PAYLOAD_TOO_LARGE` · `429 RATE_LIMITED` · `500 INTERNAL_ERROR`

## Catálogo de códigos de erro

| código | mensagem padrão |
|---|---|
| `VALIDATION_ERROR` | Request validation failed |
| `UNAUTHENTICATED` | Authentication is required. |
| `SESSION_EXPIRED` | Session has expired. |
| `INVALID_CREDENTIALS` | Credenciais inválidas. |
| `FORBIDDEN` | You do not have permission to perform this action. |
| `NO_CONTEXT_ACCESS` | Sua conta não tem acesso a nenhum espaço de trabalho. Fale com quem administra a agência para receber um convite. |
| `NOT_FOUND` | Resource not found. |
| `CSRF_REJECTED` | Request origin is not allowed |
| `PAYLOAD_TOO_LARGE` | Request payload is too large |
| `RATE_LIMITED` | Too many requests |
| `NOT_READY` | Service is not ready |
| `INTERNAL_ERROR` | An unexpected error occurred |
| `INVALID_LINK` | Este link não é mais válido. |
| `ACCOUNT_EXISTS` | Já existe uma conta para este endereço. |
| `INVITATION_ACCOUNT_MISMATCH` | A conta autenticada não corresponde ao convite. |
| `INVITATION_NOT_PENDING` | O convite não está pendente. |
| `MEMBERSHIP_EXISTS` | Este endereço já possui o vínculo solicitado. |
| `INVALID_ROLE` | O papel informado não é válido para esta agência. |
| `CLIENT_NAME_IN_USE` | Já existe um cliente ativo com este nome. |
| `CLIENT_ARCHIVED` | Cliente arquivado não pode ser editado. |
| `MEDIA_IN_USE` | Esta mídia está em um conteúdo enviado para aprovação, aprovado ou publicado e não pode ser removida. |
| `CLIENT_NOT_ARCHIVED` | Este cliente já está ativo. |
| `CLOSING_DATE_NOT_SET` | Este cliente não tem encerramento agendado. |
| `PERSONA_ARCHIVED` | Persona arquivada: a conversa é somente leitura. |
| `SECTION_NOT_FILLED` | Esta seção ainda não foi preenchida pela agência. |
| `TRY_AGAIN` | Houve um conflito momentâneo. Tente de novo. |
| `INVALID_PASSWORD` | A senha atual não confere. |
| `SAME_EMAIL` | Informe um e-mail diferente do atual. |
| `EMAIL_DELIVERY_FAILED` | Não foi possível entregar o e-mail. |
| `QUOTA_EXCEEDED` | This agency has reached its storage quota. |
| `UPLOAD_NOT_PENDING` | This upload is not pending confirmation. |
| `UNSUPPORTED_MEDIA_TYPE` | This content type is not accepted. |
| `UPLOAD_REJECTED` | The uploaded object was rejected. |
| `VARIANT_NOT_READY` | This variant has not been generated yet. |
| `VARIANT_PROCESSING_FAILED` | Video processing failed. |
