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

A consulta de `service.ts` usa a mesma fonte que `app_private.has_agency_permission`: o Owner por
posse recebe todas as chaves do catálogo (`permissions`), e qualquer outro recebe as chaves de
`role_permissions` do papel do vínculo ativo, com o papel restrito a
`role.agency_id is null or role.agency_id = agencyId`. Papel de outra agência não concede nada.

O teste de integração `agencies.integration.test.ts` compara a lista, **chave por chave**, com
`app_private.has_agency_permission` para os cinco presets, para o Owner e para papel personalizado
— trocar a permissão na consulta deixa a suíte vermelha.

O rótulo do papel de um Owner sem vínculo cai no preset `admin`, como já acontece em
`GET /me/contexts`; as permissões continuam sendo o campo autoritativo.

## O que ficou de fora

- A montagem do menu e o cache por agência no frontend (#181).
- Papéis personalizados por tela: continuam fora do MVP (`specs/autorizacao.md` §10).
