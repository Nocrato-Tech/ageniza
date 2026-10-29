# Agências

Entrega `GET /agencies/:agencyId/me` (issue #180): as permissões efetivas do contexto de agência
ativo, com o nome da agência e o rótulo do papel. É o que a casca da área da agência (#181) lê para
montar o menu e decidir quais botões aparecem.

## É só UX

A resposta **não autoriza nada**. Toda operação continua validada duas vezes, como manda
`specs/autorizacao.md` §2: a guarda da API (`requirePermission`) e a policy de RLS no banco
(`app_private.has_agency_permission`). Esconder um item de menu é conforto; descobrir a URL na mão
não concede nada, e a tela trata a URL sem permissão como "não encontrado", não como acesso negado
(`specs/autorizacao.md` §7).

## De onde vem a lista

A consulta de `service.ts` lê as chaves de `app_private.agency_permission_keys(agency_id)`, a função
única que resolve o que a pessoa tem na agência (#189): o Owner por posse recebe todas as chaves do
catálogo (`permissions`), e qualquer outro recebe as chaves de `role_permissions` do papel do vínculo
ativo, com o papel restrito a `role.agency_id is null or role.agency_id = agencyId`. Papel de outra
agência não concede nada. A guarda (`tenancy/guards.ts`) lê da mesma função; só o rótulo do papel fica
escrito na consulta.

A RLS **não** usa essa função (cada linha chamaria uma função dentro de outra, de 4,5 a 12,6 vezes mais
lento): `app_private.has_agency_permission` tem corpo próprio, e `agency-permission-keys.integration.test.ts`
(banco) prende as duas, chave por chave. O teste de integração `agencies.integration.test.ts` compara a
lista com `app_private.has_agency_permission` para os cinco presets, para o Owner e para papel
personalizado, e `tenancy/guards.integration.test.ts` faz o mesmo com o `request.tenant` da guarda —
trocar a permissão na consulta deixa a suíte vermelha.

O rótulo do papel de um Owner sem vínculo cai no preset `admin`, como já acontece em
`GET /me/contexts`; as permissões continuam sendo o campo autoritativo.

`membershipId` (#265) é o id do vínculo ativo da própria pessoa na agência pedida (`null` para o Owner que é dono só por posse), o mesmo
id que `owner.membershipId` de um conteúdo carrega, para a tela saber se a pessoa é o responsável sem expor id de usuário.

## Plano, período de teste e criação (#708, #709)

`GET /agencies/:agencyId/me` traz `plan`: `kind` (`trial`, `ativo` ou `isenta`), `trialEndsAt`, `readOnly`, que o
relógio do banco decide (`trial_ends_at <= now()`), e `supportContactEmail`, o contato público de `SUPPORT_CONTACT_EMAIL`
(`null` quando não configurado). É UX, como as permissões: quem recusa é o banco.

Com os planos pagos (#772), `plan` também traz `paidPlanKey` (o plano pago de uma agência `ativo` com assinatura ou cortesia),
`canceled` e `graceEndsOn` (o último dia para pagar, no dia de São Paulo, enquanto o período acabou e a agência ainda escreve).
Vêm de `app_private.subscription_overview`, e `readOnly` vem de `app_private.agency_is_read_only`, que responde só para membro da
agência: a API não compara relógio nenhum. A assinatura em si está em `modules/subscriptions`.

`POST /agencies` cria uma agência em teste por `app_private.create_trial_agency(name)`, que tira o ator da transação.
Só conta com e-mail confirmado (`403 EMAIL_NOT_VERIFIED`) e no máximo uma agência em teste por conta e por e-mail normalizado (minúsculas, sem `+alias` e, em gmail.com e
googlemail.com, sem pontos e com o domínio unificado: `app_private.trial_email_key`), vencida ou não
(`409 TRIAL_ALREADY_EXISTS`; numa corrida, as travas por conta e por chave fazem a segunda criação ver a primeira, e os índices únicos
`agencies_one_trial_per_owner` e `agencies_one_trial_per_email_key` são a última barreira). Quem cria vira Owner com
o vínculo Admin, e a agência ganha a cota de 2 GiB em `agency_storage_quotas`. A resposta é o contexto novo.

O que o banco impõe (migrations `20261027020000` e `20261027020100`), em todos os módulos, e a API responde sem 500
(`plugins/infra/errors.ts`):

- **Somente leitura** ao fim do teste: um gatilho `00_<tabela>_agency_accepts_writes` em toda tabela de dados da agência
  recusa insert, update e delete com ator (A0090, `409 AGENCY_READ_ONLY`). Continuam: remover colaborador, remover
  acesso ao portal e cancelar convite, reconhecidos pela mudança exata da linha. O worker escreve sem ator e não é
  barrado (fila, retenção de mídia, arquivamento agendado), mas a fila descarta os e-mails da agência
  (`notification_item_still_holds`). Convite de agência vencida não é válido nem aceitável.
- **Limites do teste**: 3 clientes ativos (A0091, `409 TRIAL_CLIENT_LIMIT`) e 3 colaboradores contando o Owner e os
  convites de colaborador pendentes (A0092, `409 TRIAL_COLLABORATOR_LIMIT`), contados depois de uma trava consultiva por
  agência, para duas criações ao mesmo tempo não verem a mesma vaga. Convite vencido não ocupa vaga; o Owner conta pela posse.
- **Limite diário de e-mails**: cada convite de colaborador ou de portal criado ou reenviado conta no dia de Brasília;
  20 no teste e 200 nos outros planos, ou o de `agencies.daily_email_limit` (`cli:agency set-email-limit`). Passou,
  A0095, `429 DAILY_EMAIL_LIMIT`, contado sob trava por agência.

`GET /me/contexts` traz `canCreateAgency`, da mesma regra (`app_private.can_create_trial_agency()`), e o portal recebe
`agencyReadOnly` em `GET /clients/:clientId`. A aplicação nunca muda `plan`: só `cli:agency set-plan`, da operação, auditado.

## O que ficou de fora

- A montagem do menu e o cache por agência no frontend (#181).
- Papéis personalizados por tela: continuam fora do MVP (`specs/autorizacao.md` §10).
