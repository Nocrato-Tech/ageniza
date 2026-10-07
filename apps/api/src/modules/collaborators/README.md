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

## Alterar cargo e papel (`PATCH`, issue #97)

`PATCH /agencies/:agencyId/collaborators/:membershipId` aceita `jobTitle`, `roleId` ou os dois. A
permissão exigida é a **de cada campo presente**, não a da rota. A guarda (`requireAnyPermission`, derivada
de `docs.permission`) só barra quem não poderia mudar nada (`alterar_funcao` ou `alterar_papel`); o resto
é decidido depois de ler o corpo, com `request.tenant` (`policy.ts`):

| corpo | exige |
|---|---|
| só `jobTitle` | `colaborador.alterar_funcao` |
| só `roleId` | `colaborador.alterar_papel` |
| os dois | as duas |
| `roleId` do papel `admin` | mais `colaborador.atribuir_admin` |

O papel é `admin` pela mesma função do banco (`app_private.is_admin_role`) que o trigger de UPDATE e a
policy de `invitations` usam: papel de sistema ou da agência com chave `admin`. A permissão é pedida,
não a posse: o Owner passa por curto-circuito, e quem receber `atribuir_admin` num papel
personalizado também passa. O mesmo vale em `POST …/invitations/collaborators` e no reenvio de um
convite com papel `admin` (módulo `invitations`).

Proteções, todas `403` com mensagem própria: o papel do **Owner** não muda, nem para o mesmo papel
que ele já tem; **ninguém altera o próprio papel** (compara com `request.auth`, nunca com o corpo).
O cargo do Owner e o do próprio usuário continuam editáveis pela permissão de cargo.

Ordem das respostas: 401 sem sessão; 404 se a agência não é acessível; 403 se falta a permissão
da porta; 400 do corpo; 403 se falta a permissão de algum campo presente (antes de qualquer leitura,
então quem não pode não descobre nada, nem que o id é malformado); 404 para vínculo de outra agência,
inexistente, malformado ou removido; 400 `INVALID_ROLE` para papel que não é de sistema nem da agência;
403 se o papel é `admin` e falta `atribuir_admin`; 403 de Owner e de si mesmo.

A linha é lida com `for update` e a escrita grava **só os campos presentes**, então duas mudanças
simultâneas de campos diferentes não se sobrescrevem. `UPDATE` que não altera nenhuma linha (a policy
filtra em silêncio) nunca vira 200: vira 403. Um `42501` do banco (policy ou trigger) também vira 403,
não 500. As duas barreiras continuam: a da API devolve a mensagem, a do banco é a que sobra se alguém
esquecer a da API.

`jobTitle` tem de 1 a 256 caracteres depois do `trim`, sem caracteres de controle (mesma regra do
filtro `jobTitle` da listagem, para todo cargo gravado ser filtrável), e `null` limpa. O limite é
aplicado pelo schema antes de a requisição chegar ao banco, que mede o tamanho com uma função
quadrática.

## O que ficou de fora

- **O filtro de removidos chega com a #98.** A SPEC exige permissão administrativa para revelar
  vínculos `removed` (regra inviolável 9). Por isso, nesta fase, `status` aceita só `active`,
  `?status=removed` é 400 e o detalhe de um removido é 404; a visão administrativa entra na
  #98/#105.
- **Remuneração.** Não existe neste módulo; pertence ao Financeiro.
- **Remoção, reativação, convites e edição de perfil.** São outras rotas do módulo (#98 e seguintes).
- **Auditoria da troca de papel.** `audit.events` não registra "quem mudou este campo"; ver
  "Rastreio de alteração de dados" em `docs/business/structural-changes.md`.
