# Módulo `contents` (issue #254)

O conteúdo de um cliente, do lado da agência: a **consulta por período** (calendário e feed), criar,
ler e editar, e mover de data (que é editar `publishOn`). Todas as rotas sob `requireSession` e
`requireAgencyAccess`; o cliente de `:clientId` precisa pertencer à agência do caminho, e o conteúdo,
ao cliente, senão o mesmo `404`.

| método | rota | permissão |
|---|---|---|
| `GET` | `/agencies/:agencyId/clients/:clientId/contents?from=&to=` | `conteudo.visualizar` |
| `POST` | `/agencies/:agencyId/clients/:clientId/contents` | `conteudo.operar` e `conteudo.visualizar` |
| `GET` | `/agencies/:agencyId/clients/:clientId/contents/:contentId` | `conteudo.visualizar` |
| `PATCH` | `/agencies/:agencyId/clients/:clientId/contents/:contentId` | `conteudo.operar` e `conteudo.visualizar` |

Os contratos estão em `packages/contracts/src/contents.ts`; as decisões, em
`docs/business/decisions/2026-10-11-conteudo-*.md` e `2026-10-11-consulta-por-periodo-teto-de-500-itens-e-formato-da-resposta.md`. Os estados, as transições (enviar, aprovar,
publicar, cancelar, reagendar), as subtarefas, as pastas e os roteiros são de outras issues e **não**
estão aqui.

## A consulta por período

É o formato que Tarefas e Dashboard copiam. `from` e `to` são dias `AAAA-MM-DD` incluídos; até 93 dias
contando os dois extremos (93 passa, 94 é `400`); até 500 itens somando conteúdos e roteiros (acima,
`400 CONTENT_PERIOD_TOO_LARGE`, sem cortar); não pagina. A resposta é
`{ data: { contents, storyScripts }, meta: { from, to, count } }`, ordenada por dia, hora (sem hora por
último) e `id`. O item de conteúdo não traz legenda nem mídia.

## O que o banco decide e a rota só traduz

O estado, a aprovação e a revisão são do banco (gatilhos da migration `20261007001200`): a rota grava as
colunas que o grant permite e devolve a linha lida depois. Por isso um `PATCH` de legenda, capa, formato
ou mídia num conteúdo aprovado devolve `awaiting_approval`, e mudar data, hora, título ou responsável
mantém a aprovação.

- **Escrita exige leitura.** A guarda da rota pede as duas permissões, como a policy.
- **O responsável** só muda com `conteudo.aprovar_pela_agencia` (`403` antes de gravar; o gatilho do banco
  também recusa, com `42501`, e a rota traduz).
- **Formato e mídia** (`mediaAssetIds`, a lista inteira e ordenada) são gravados na mesma transação, o
  formato primeiro. Depois do envio para aprovação não se vai de carrossel para uma mídia só (nem o inverso)
  num `PATCH`: `409 CONTENT_MEDIA_INCOMPLETE`, e o caminho é cancelar e reagendar.
- **A corrida com o arquivamento** tem duas janelas, e as duas respondem `409 CLIENT_ARCHIVED` sem gravar:
  o arquivamento em curso (`A0020`) e o já confirmado antes da escrita (`42501` da policy, lido de novo
  numa transação nova). Ver `errors.ts`.

## O que ficou de fora

Mídia e pastas (`apps/api/src/modules/media`, #253), subtarefas (#255), os estados (#256, #257, #259),
roteiros (#258) e o portal. O texto livre usa os schemas de `packages/contracts` (título de uma linha,
legenda com quebras), que recusam caractere de controle e invisível.

## Testes

- `contents.integration.test.ts`: autorização por rota com papéis de uma ou duas permissões, isolamento
  (inclusive a pessoa com vínculo em duas agências), o período, criar, ler, editar e mover.
- `contents-archive-race.integration.test.ts`: as duas janelas da corrida com o arquivamento e o deadlock.
- `errors.test.ts`: a tradução de cada código do banco, sem banco.
