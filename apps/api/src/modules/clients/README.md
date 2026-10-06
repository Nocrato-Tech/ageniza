# Módulo `clients` (issue #124)

Cadastrar, ler e editar o cliente da agência. As três rotas básicas do módulo, sob
`requireSession` e `requireAgencyAccess`, com a permissão nomeada que a policy de RLS da tabela
também exige:

| método | rota | permissão |
|---|---|---|
| `POST` | `/agencies/:agencyId/clients` | `cliente.cadastrar` |
| `GET` | `/agencies/:agencyId/clients/:clientId` | `cliente.visualizar` |
| `PATCH` | `/agencies/:agencyId/clients/:clientId` | `cliente.operar` |
| `PUT` | `/agencies/:agencyId/clients/:clientId/photo` | `cliente.operar` |
| `DELETE` | `/agencies/:agencyId/clients/:clientId/photo` | `cliente.operar` |

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

## Foto (issue #126)

`PUT .../photo` recebe `{ imageBase64 }` (JSON, o transporte que a #100 escolheu para todo ativo de
identidade) e devolve `{ photoUrl }`; `DELETE .../photo` devolve `204`. O objeto vive no
armazenamento de identidade, nunca em `media_assets`, e **não entra em quota de agência**.

- **Tipo pelo conteúdo.** `uploadIdentityImage` lê os magic bytes; não há `contentType` no contrato
  e o corpo é `.strict()`, então um rótulo declarado é 400. SVG, HTML e bytes desconhecidos são 415,
  imagem acima do teto é 413, e **nada é gravado** em nenhum dos casos.
- **Tamanho antes do corpo.** A rota declara o próprio `bodyLimit` (`policy.ts`): o parser do
  Fastify recusa com 413 antes de qualquer handler ler o corpo. O limite global não foi aumentado.
- **A chave vem só de ids do servidor**: `agencies/<agencyId>/clients/<clientId>/avatar/<uuid>.<ext>`,
  com `agencyId` da rota autorizada e `clientId` validado como UUID (inválido é 404, como no resto
  do módulo). Nada do corpo, da query ou do cabeçalho entra na chave.
- **Cliente arquivado ou inexistente** é checado **antes** do envio ao bucket (409 `CLIENT_ARCHIVED`
  ou o 404 indistinto). Se o arquivamento acontecer entre a checagem e o commit, o objeto recém
  gravado é removido e a resposta é a mesma.
- **Protocolo da #100.** O objeto novo é gravado, a referência é confirmada sob `select ... for
  update` na linha do cliente, e só então o anterior é apagado. O lock serializa trocas
  concorrentes (sem ele sobra objeto órfão). Falha ao confirmar apaga o objeto novo.
- **Só se apaga o que é do cliente.** `photo_key` é dado numa tabela: antes de apagar o objeto
  anterior a rota confere que a chave ainda está no diretório do próprio cliente
  (`isClientAvatarKey`). Uma referência que aponte para outro cliente ou outra agência é registrada
  em `warn` e **não** apagada.
- **Teto por usuário** (`CLIENT_PHOTO_RATE_LIMIT`, 30 por minuto): o armazenamento de identidade
  não tem quota, então o teto segue a conta. Mesmo número da foto de perfil.
- As leituras (detalhe, resposta do `PATCH`) assinam a referência com a mesma validade; o bucket
  nunca é público.

## O que ficou de fora

- Listagem (`#125`), arquivar/reativar e encerramento (`#131`).
- A foto na listagem e no portal (`#125`, `#129`): as rotas ainda não existem; ao nascerem devem assinar
  `photo_key` do mesmo jeito que o detalhe.
- O restante do módulo (estudo de marca, personas, conversas, acessos) e o portal do cliente.
