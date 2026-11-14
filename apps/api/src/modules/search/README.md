# Busca da agência

A leitura por trás da busca da barra superior (Ctrl K) (`specs/busca.md` seções 2 a 6; decisão
`2026-11-11-busca-na-agencia-e-no-portal`), sobre as tabelas `clients`, `contents` e `media_assets` e o contrato de
`packages/contracts/src/agency-search.ts`. Só lê: não há tabela, função, policy nem migration nova, e nenhuma função `security definer`
a atende. O risco é **Alto**: a resposta traz nomes de clientes de uma agência para quem tem a permissão certa, e o que importa é o que
quem não tem consegue inferir.

## A rota

`GET /agencies/:agencyId/search?q=`, sob `requireSession` e `requireAgencyAccess`, depois o limite de requisições. Não tem permissão
única: cada grupo pede a sua.

| grupo | permissão | casa por | devolve |
|---|---|---|---|
| `clients` | `cliente.visualizar` | nome, razão social e @ (sem o `@`) | `id`, `name`, `photoUrl`, `instagramHandle`, `archived` |
| `contents` | `conteudo.visualizar` | título | `id`, `clientId`, `clientName`, `title`, `format`, `status`, `overdue`, `scheduled`, `publishOn` |
| `files` | `conteudo.visualizar` | nome do arquivo | `id`, `clientId`, `clientName`, `folderId`, `name`, `category`, `thumbnailAssetId` |

A resposta é `{ data: { clients, contents, files }, meta: { q } }`, com os três grupos sempre presentes e até 6 em cada.

## Onde cada regra mora

- **O que quem não pode ler não infere.** `routes.ts` decide o acesso de cada grupo com `tenantHolds` (o Owner passa por posse) e
  `service.ts` **não executa** a consulta do grupo sem acesso: ele vem `[]` sem uma instrução ao banco, então o formato, o tempo e os
  erros de quem não pode ler conteúdo são os de quem pode e não achou nada. O teste conta as instruções que chegam às tabelas, por
  papel. A tela nunca diz "sem permissão".
- **A agência da rota está no WHERE das três consultas.** `clients_select` mostra à pessoa todas as agências a que ela pertence, e a
  pessoa de um cliente no portal de outra agência lê esse cliente também: só o filtro `client.agency_id = :agencyId` mantém a outra
  agência de fora. `contents` chega à agência pelo cliente. `media_assets` leva a agência **também na própria linha**
  (`asset.agency_id`): só pela junção com o cliente, o planejador podia varrer os arquivos de todas as agências, avaliando a policy em
  cada um, e o custo da busca de uma agência seguiria o volume das outras. O teste de plano prende isso (sem `Seq Scan on media_assets`,
  com 30 mil arquivos em outra agência). O teste das três policies em `using (true)` mostra que a agência e a permissão de cada grupo
  continuam seguras.
- **O termo é dado, nunca SQL.** Aparado, de 2 a 80 caracteres, sem caractere de controle (`AgencySearchQuerySchema`, `.strict()`); vai
  como parâmetro, e `%`, `_` e a barra invertida são escapados para valerem como texto. O dobramento (sem acento e sem maiúscula) é
  `foldTextSql`, o mesmo da carteira e da Equipe, aplicado à coluna e ao termo. O `@` do começo vale só para o campo do @. O mínimo de
  2 é medido pela rota **depois** de tirar os acentos e o `@` (`searchedCharacters`, de `@ageniza/contracts`, a mesma que a tela usa): termo de marcas combinantes, `á` e um `@` com marca ficam
  abaixo dele e recebem o `400` de um termo curto, em vez de virar um padrão vazio que casa tudo.
- **O arquivo achado é o confirmado e não removido.** Envio em andamento, recusado e removido não aparecem; mídia sem nome (anterior ao
  nome) não casa. Cliente arquivado e conteúdo cancelado aparecem, com `archived` e `status`.
- **Ordem e teto.** Dentro de cada grupo: o nome que começa com o termo antes do que só o contém, depois o nome dobrado
  (`collate "C"`) e o `id`. Seis por grupo; quem quer mais refina o termo.
- **Os derivados do conteúdo** (`overdue`, `scheduled`) saem das definições de `packages/contracts` (`contentDeadline`,
  `contentIsScheduled`) lidas no relógio de São Paulo da mesma instrução. O relógio é uma cópia curta da leitura de
  `contents/clock-sql.ts`, porque um módulo não importa o arquivo interno de outro; um módulo de contratos ou de infra que a exporte
  a trocaria.
- **A foto** do cliente é assinada só quando a chave guardada é exatamente a do avatar daquele cliente (`isClientAvatarKey`), com a
  agência da linha do banco e nunca a da URL (que a guarda aceita em qualquer caixa); uma
  chave estranha, a falta do armazenamento ou uma assinatura recusada dão `photoUrl: null`, e o log leva o código, nunca a chave.
- **O termo não vai para o log nem para métrica.** O log da requisição usa o padrão da rota (`/agencies/:agencyId/search`), nunca a URL, e
  a recusa de um termo inválido nomeia o campo e a regra, sem o valor. A resposta do termo válido traz `meta.q`.
- **Limite de requisições:** 60 por minuto por pessoa (`sharedUserRateLimit`), num balde só para todas as agências dela, depois das
  guardas (a requisição que a guarda recusa não conta). `429 RATE_LIMITED` com `Retry-After`. Fica em memória no processo, como os
  outros limites por pessoa.
- **Erros do banco** (`errors.ts`): `42501` vira `403`, `40P01` e `40001` viram `409 TRY_AGAIN`; nada do detalhe chega à resposta.
- **A pessoa do portal** não usa a rota: sem vínculo com a agência, recebe o `404` do guard. A agência em somente leitura busca; a
  suspensa é fechada pelo guard para toda rota.

## O que ficou de fora

Busca de pessoas da equipe, de conversas e de legenda; paginação e "ver todos"; busca difusa; histórico. Um índice de apoio (trigrama) só
entra se a medição passar de 200 ms, como migration nova (`specs/busca.md` seção 10).
