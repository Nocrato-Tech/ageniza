# Colaboradores

Entrega `GET /agencies/:agencyId/collaborators` (issue #95) e
`GET /agencies/:agencyId/collaborators/:membershipId` (issue #96): a equipe da agência, paginada,
com busca e filtros, e o detalhe de uma pessoa em URL própria. A listagem é a **primeira do
produto**, e por isso as próximas a copiam — o contrato está em
`packages/contracts/src/pagination.ts` e o desenho, em `specs/autorizacao.md` §6.

## A consulta parte do vínculo, nunca do usuário

`auth."user"` **não tem RLS**: o `ageniza_app` lê qualquer pessoa da plataforma. Nome, e-mail e
foto só ficam isolados porque a consulta de `service.ts` parte de `public.agency_memberships`,
filtra pela agência da rota e alcança o usuário pelo `user_id` daquele vínculo. Um `from
auth."user"` com join na direção oposta, ou uma subconsulta que resolva pessoas por nome antes de
filtrar a agência, devolve gente de outras agências — e a resposta parece correta. É a regra
inviolável nº 2 de `specs/colaboradores.md`.

A ordenação é sempre por nome ascendente, com desempate por `membership.id`, para que a paginação
seja estável entre chamadas.

O detalhe usa a mesma consulta, filtrada por `membership.id`, com o mesmo filtro de agência: um
vínculo de outra agência não é uma linha, e a rota responde o mesmo 404 de um id inexistente — nunca
403, que confirmaria a existência. Id malformado também cai nesse 404. Vínculo `removed` é 404 até
a task de remoção (#98) trazer a visão administrativa.

## Permissão

`colaborador.visualizar`, exigida por `requirePermission` depois de `requireAgencyAccess` nas duas
rotas. Quem não tem a chave recebe 403; quem não tem acesso à agência recebe 404 indistinto, igual
ao de agência inexistente. A lista é a mesma para todos os papéis: o total não depende de quem olha
(`specs/colaboradores.md` §5, regra 1).

## Foto

`auth."user".image` guarda a **chave** do armazenamento de identidade (issue #100), nunca uma URL
pública. As rotas devolvem uma URL assinada de curta duração via `presignGetObject`, ou `null`
quando a pessoa não tem foto. Uma chave que não pode ser assinada vira `null` com `log.warn`, sem
derrubar a resposta. O módulo recebe o cliente de identidade por injeção; não constrói o seu.

## Parâmetros

`page`/`pageSize` vêm de `PaginationInputSchema` (padrão 24, teto global de 100 que **limita** em
vez de recusar, e guarda de overflow do `page`). A busca `q` procura por trecho do nome **e** do
e-mail, sem diferenciar maiúsculas, com `%` e `_` escapados. `role` filtra por chave de papel e
`jobTitle` por cargo, isolados ou combinados.

`q`, `role` e `jobTitle` usam o `SearchTextSchema` compartilhado (`packages/contracts`), que recusa
caracteres de controle: um byte NUL chega ao backend como parâmetro inválido (22021) e viraria 500.

## O que ficou de fora

- **O filtro de removidos chega com a #98.** A SPEC exige permissão administrativa para revelar
  vínculos `removed` (regra inviolável 9). Por isso, nesta fase, `status` aceita só `active`,
  `?status=removed` é 400 e o detalhe de um removido é 404; a visão administrativa entra na
  #98/#105.
- **Remuneração.** Não existe neste módulo; pertence ao Financeiro.
- **Remoção, reativação, convites e edição de perfil.** São outras rotas do módulo.
