# Módulo `clients` (issue #124)

Cadastrar, ler e editar o cliente da agência. As três rotas básicas do módulo, sob
`requireSession` e `requireAgencyAccess`, com a permissão nomeada que a policy de RLS da tabela
também exige:

| método | rota | permissão |
|---|---|---|
| `POST` | `/agencies/:agencyId/clients` | `cliente.cadastrar` |
| `GET` | `/agencies/:agencyId/clients/:clientId` | `cliente.visualizar` |
| `PATCH` | `/agencies/:agencyId/clients/:clientId` | `cliente.operar` |

O `POST` aceita só `{ name }`. O `PATCH` aceita qualquer subconjunto dos campos de cadastro da
seção 3 da SPEC, e `null` limpa um campo. Contratos em `packages/contracts/src/clients.ts`.

## Regras que o banco não pode deixar só para a rota

- **Nome em uso** entre os ativos: a rota traduz a violação do índice `clients_active_name_unique`
  (código `23505`) em `409 CLIENT_NAME_IN_USE`, nunca por consulta prévia -- é o índice que decide,
  então dois `POST` simultâneos dão exatamente um `201` e um `409`.
- **Cliente arquivado** no `PATCH`: a RLS devolve **0 linhas** (a policy `clients_update` exige
  `status = 'active'`); a rota confirma que o cliente existe na agência e responde
  `409 CLIENT_ARCHIVED`. Cliente inexistente, de outra agência ou `:clientId` inválido é o mesmo
  `404`, sem distinguir.
- `created_at`, `status` e `updated_by` **nunca** vêm do corpo; `updated_by` é o usuário da sessão.

## Detalhe e resumo

`GET` devolve o cadastro completo mais o resumo da aba Geral: `brandStudyFilled` (0 a 7, com
`personas` contando quando há ao menos uma ativa), `threadsAwaitingAgency`, `threadsAnsweredByAgency`
e `activePortalMembers`.

A definição de thread aberta, "aguardando a agência" e "com resposta da agência" vive **uma vez só**
em `thread-state.ts`, exportada: é o mesmo critério que a listagem (#125), o portal (#129) e as
rotas de conversa devem importar, para a contagem não divergir entre telas.

`photoUrl` é uma URL assinada do armazenamento de identidade, ou `null`. Chave ausente ou
irrecusável vira `null` com `log.warn`, sem derrubar a resposta -- nunca uma chave crua.

## Conversa (issue #128)

O lado da agência do modelo de conversa do produto: `GET`/`POST .../threads`,
`GET`/`POST .../threads/:threadId/comments` e `POST .../threads/:threadId/resolve`. Contratos em
`packages/contracts/src/conversations.ts`.

O serviço vive em `conversation.ts` e é **genérico no assunto**: recebe um `ThreadSubject` (uma
seção ou uma persona) e não depende de qual é. É o mesmo serviço que o portal (#130) usa com
`side = 'client'`, e Conteúdo acrescenta um `contentId` como terceiro assunto -- nunca uma segunda
tabela de conversa.

- **O estado é derivado**, nunca persistido: `openThreadSql`/`latestCommentSideSql` em
  `thread-state.ts`. Comentar numa thread resolvida a reabre sem escrita na thread, e não existe
  rota de reabrir.
- **O lado nunca vem do corpo**: `opened_side`/`author_side` são escolhidos pela rota (a da agência
  escreve `agency`), e a policy de RLS confere a credencial do lado.
- **O autor é lido pelo comentário**: nome e foto vêm pelo vínculo de agência (`agency`) ou de
  cliente (`client`), nunca de `auth."user"` por um id solto; sem vínculo, o autor é `null`.
- Abrir, comentar e resolver num cliente arquivado respondem `409`; ler funciona. Persona de outro
  cliente como assunto é o mesmo `404`.

## O que ficou de fora

- Listagem (`#125`), foto (`#126`), arquivar/reativar e encerramento (`#131`).
- O portal da conversa (`#130`) e o estudo de marca/personas e acessos.
- Editar e apagar comentário: não existem, por contrato e por grant.
