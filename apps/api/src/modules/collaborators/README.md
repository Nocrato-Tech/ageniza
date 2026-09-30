# Colaboradores

Entrega `GET /agencies/:agencyId/collaborators` (issue #95),
`GET /agencies/:agencyId/collaborators/:membershipId` (issue #96) e
`POST .../:membershipId/remove` e `.../reactivate` (issue #98): a equipe da agência, paginada, com
busca e filtros, o detalhe de uma pessoa em URL própria, e a remoção/reativação do vínculo. A
listagem é a **primeira do produto**, e por isso as próximas a copiam — o contrato está em
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

O detalhe e as duas escritas usam a mesma consulta, filtrada por `membership.id`, com o mesmo filtro
de agência: um vínculo de outra agência não é uma linha, e a rota responde o mesmo 404 de um id
inexistente — nunca 403, que confirmaria a existência. Id malformado também cai nesse 404.

## Remover e reativar

**Remover** (`colaborador.remover`) faz `status = 'removed'` e **mantém a linha**: nenhuma rota
apaga entidade de negócio. **Reativar** (`colaborador.alterar_papel`) volta o **mesmo** `id` para
`active` e exige `role_id` novo no corpo — quem volta pode voltar em outra função, e herdar o papel
antigo em silêncio é o que `specs/autorizacao.md` regra 8 proíbe. Conceder `admin` exige
`colaborador.atribuir_admin`, e quem garante isso é o trigger do banco: a rota traduz o SQLSTATE
42501 em 403.

O **Owner** não é removido (é propriedade da agência, não papel) e **ninguém remove a si mesmo**.
Remover um vínculo já removido é **idempotente** (200, nada muda). A proteção "não remover o último
Admin" foi deliberadamente descartada (`decisions.md`, 2026-09-24) e não existe aqui.

## Permissão

`colaborador.visualizar` na listagem e no detalhe; `colaborador.remover` na remoção;
`colaborador.alterar_papel` na reativação — todas por `requirePermission` depois de
`requireAgencyAccess`. Quem não tem a chave recebe 403; quem não tem acesso à agência recebe 404
indistinto. A lista é a mesma para todos os papéis (`specs/colaboradores.md` §5, regra 1).

Revelar vínculos `removed` exige `colaborador.remover` **ou** `colaborador.alterar_papel` (ou ser o
Owner): quem pode remover ou reativar precisa encontrar a pessoa. Sem essa permissão,
`?status=removed` é 403 e o detalhe de um removido é 404. Decisão de 2026-09-30 registrada em
`decisions.md`, **pendente de validação** do dono do produto.

## Foto

`auth."user".image` guarda a **chave** do armazenamento de identidade (issue #100), nunca uma URL
pública. As rotas devolvem uma URL assinada de curta duração via `presignGetObject`, ou `null`
quando a pessoa não tem foto. Uma chave que não pode ser assinada vira `null` com `log.warn`, sem
derrubar a resposta. O módulo recebe o cliente de identidade por injeção; não constrói o seu.

## Parâmetros

`page`/`pageSize` vêm de `PaginationInputSchema` (padrão 24, teto global de 100 que **limita** em
vez de recusar, e guarda de overflow do `page`). A busca `q` procura por trecho do nome **e** do
e-mail, sem diferenciar maiúsculas, com `%` e `_` escapados. `role` filtra por chave de papel,
`jobTitle` por cargo e `status` por `active`/`removed` (este último com a guarda acima).

`q`, `role` e `jobTitle` usam o `SearchTextSchema` compartilhado (`packages/contracts`), que recusa
caracteres de controle: um byte NUL chega ao backend como parâmetro inválido (22021) e viraria 500.

## O que ficou de fora

- **Remuneração.** Não existe neste módulo; pertence ao Financeiro.
- **Troca de papel e de cargo** (`PATCH`, #97), **convites** e **edição do próprio perfil**. São
  outras rotas do módulo.
