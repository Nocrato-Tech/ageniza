# Contextos (AUTH-20C)

Este módulo entrega a resolução, listagem e troca de contexto (agência ou portal de cliente)
depois do login, a preferência de último contexto usado e o registro do primeiro acesso ao
portal de um cliente. É só backend: telas, busca com muitos contextos e o checklist do Owner são
responsabilidade do frontend.

## Por que o contexto vive na rota, e não na sessão

Cada requisição autenticada já informa explicitamente em qual agência ou cliente ela está atuando
(`/agencies/:agencyId/...` ou `/clients/:clientId/...`), e as guardas (`requireAgencyAccess`,
`requireClientAccess`) revalidam esse acesso a cada chamada, consultando o banco sob a mesma
transação (`withAuthenticatedUserTransaction`). Não existe "contexto ativo" guardado na sessão:

- **Múltiplas abas/dispositivos funcionam sem interferência.** Duas requisições concorrentes da
  mesma pessoa, uma para a agência A e outra para a agência B, não competem por um único estado de
  contexto guardado no servidor -- cada requisição prova seu próprio acesso.
- **Revogação é imediata.** Quando um vínculo é marcado `removed`, um cliente é `archived` ou uma
  agência é `suspended`, a próxima requisição a esse contexto responde `404` sem exigir logout, e
  os outros contextos da mesma pessoa continuam funcionando normalmente -- não há cache de acesso
  para invalidar.

A preferência de "último contexto" (`user_context_preferences`) é uma conveniência de navegação
salva por pessoa (não por sessão/dispositivo). Ela **nunca concede acesso por si só**: toda vez que
é usada para decidir para onde levar a pessoa, o contexto apontado é revalidado contra o banco.

## Regras de validade de um contexto

| Tipo | Válido quando |
|---|---|
| Agência | a pessoa é `owner` da agência **ou** tem `agency_memberships` com `status = 'active'`, **e** a agência tem `status = 'active'` |
| Cliente | a pessoa tem `client_memberships` com `status = 'active'` para o cliente, **e** o cliente tem `status = 'active'`, **e** a agência do cliente tem `status = 'active'` |

Uma agência `suspended` nunca aparece em nenhuma lista, resolução ou guarda, mesmo que a pessoa
seja owner ou membro ativo dela. Um colaborador da agência não ganha acesso ao portal de um
cliente daquela agência só por ser colaborador: portal de cliente e área interna da agência são
contextos diferentes, e `requireClientAccess` exige um vínculo de cliente explícito e ativo.

## Algoritmo de `GET /me/contexts/resolve`

Nesta ordem exata (issue #33, spec seções 5 e 12.1):

1. Calcula `contexts = listValidContexts(...)`, já ordenado (ver abaixo).
2. Se `contexts` está vazio: `{ decision: 'none' }`.
3. Se há exatamente um contexto válido: `{ decision: 'enter', context: contexts[0] }`.
4. Se a query `preferred` (`agency:<uuid>` ou `client:<uuid>`) aponta para um contexto presente em
   `contexts`, esse contexto "ganha" mesmo que exista um último contexto usado válido:
   `{ decision: 'select', contexts, highlighted: <preferred> }`. Este é o caminho típico logo
   depois de aceitar um convite.
5. Senão, se o último contexto usado (gravado por `PUT /me/last-context`) ainda é válido:
   `{ decision: 'enter', context: <último> }`.
6. Senão: `{ decision: 'select', contexts, highlighted: null }`.

Um `preferred` inválido, inexistente ou sem acesso é **ignorado em silêncio**: nenhum erro, nenhuma
diferença perceptível na resposta, e o algoritmo simplesmente segue a partir do passo 5. Isso evita
que a resposta revele se um `agencyId`/`clientId` arbitrário existe.

A resolução nunca grava o "último contexto". Só `PUT /me/last-context` grava, e é o próprio
frontend que chama essa rota no momento em que a pessoa efetivamente entra em um contexto. A troca
de contexto dentro do produto é, por construção, `PUT /me/last-context` seguido de navegação para a
home do novo contexto -- não existe uma rota de "troca" separada, e a API não tenta preservar a
rota do tenant anterior.

## Ordenação de `listValidContexts` (spec 6.1)

1. o último contexto usado, se ainda válido, vem primeiro;
2. os demais em ordem alfabética pelo nome exibido (`agencyName` ou `clientName`), comparados com
   `localeCompare(a, b, 'pt-BR', { sensitivity: 'base' })` (ignora acento e maiúsculas/minúsculas);
3. em empate de nome, agência antes de cliente, depois por id.

## Rotas

Todas exigem `requireSession`.

- `GET /me/contexts` -- `200 { contexts: Context[] }`, já ordenado.
- `GET /me/contexts/resolve?preferred=agency:<uuid>|client:<uuid>` -- ver algoritmo acima.
- `PUT /me/last-context` -- `{ type: 'agency', agencyId } | { type: 'client', clientId }`. Revalida
  o contexto antes de gravar; inválido devolve `404 NOT_FOUND` e não altera a preferência anterior.
  É um upsert na linha do próprio usuário (`user_context_preferences`, chave primária `user_id`).
- `POST /clients/:clientId/onboarding/seen` -- protegida por `requireClientAccess`. Grava
  `client_memberships.onboarding_seen_at` só na primeira chamada (a data não muda depois) e é
  idempotente: chamadas repetidas continuam respondendo `204`.

## Tabela `user_context_preferences`

Uma linha por usuário (`user_id` é chave primária). RLS restringe toda operação (`select`,
`insert`, `update`, `delete`) a `user_id = app_private.current_user_id()`, então mesmo com a
aplicação sempre conectada como `ageniza_app`, o usuário A nunca lê ou grava a preferência do
usuário B.
