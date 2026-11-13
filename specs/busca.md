# Busca

| | |
|---|---|
| **Status** | rascunho (decisões pendentes de validação do dono) |
| **Submódulos** | busca da agência (barra superior, Ctrl K) · busca do portal (filtro no navegador) |
| **Sessões** | 2026-11-11 |
| **Decidido por** | Pedro Vidal (dono do produto), com decisões do maestro pendentes de validação |

## 1. Propósito

Achar, de qualquer tela da agência, um cliente, um conteúdo ou um arquivo pelo nome, e chegar a ele em um passo. No portal, achar um post entre os que a tela já carregou. Decisão: [`2026-11-11-busca-na-agencia-e-no-portal`](../docs/business/decisions/2026-11-11-busca-na-agencia-e-no-portal.md).

### Não resolve

- Busca por **pessoas da equipe**, **conversas**, **legenda** ou texto dentro de arquivo.
- Busca **no servidor** para o portal: o portal filtra no navegador.
- Busca difusa, por sinônimo ou por relevância: é "contém o termo", sem acento nem caixa.
- Histórico de buscas e sugestões.
- Páginas de resultado completas ("ver todos"): cada grupo mostra poucos itens e quem quer mais refina o termo (gatilho de mudança: a primeira agência com mais de uma centena de clientes reclamar).

## 2. Atores e autorização

Não há permissão nova: cada grupo de resultado usa a permissão da leitura que ele atalha.

| grupo | permissão | quem tem no preset |
|---|---|---|
| Clientes | `cliente.visualizar` | todos os papéis |
| Conteúdos | `conteudo.visualizar` | Admin, Gestor de conta, Produção |
| Arquivos | `conteudo.visualizar` | Admin, Gestor de conta, Produção |

> Owner tem acesso total por posse. Visibilidade na tela é UX; a autorização é validada no backend e no banco em toda busca.

- Quem não tem a permissão de um grupo **não recebe o grupo, nem a sua ausência como mensagem**. A resposta de quem não pode ler conteúdo e a de quem pode e não achou nada são **indistinguíveis** no formato (`[]`), e a tela não mostra "sem permissão" (a regra de "sem permissão não é tela" de `autorizacao.md`).
- A **pessoa do portal** não usa esta busca. A do portal é só um filtro do navegador (seção 7).
- Agência em somente leitura **pode buscar** (é leitura). Agência suspensa **não busca**: recebe o mesmo `404` das demais rotas, porque a guarda de acesso à agência a fecha ([`2026-11-13-agencia-suspensa-nao-usa-a-busca`](../docs/business/decisions/2026-11-13-agencia-suspensa-nao-usa-a-busca.md)).

## 3. Entidades e campos

Nenhuma. A busca é uma **leitura** sobre `clients`, `contents` e `media_assets`, sem tabela, coluna ou índice obrigatório. Se a medição pedir, um índice de apoio é migration nova, sem tocar o que existe.

| grupo | o que casa | o que devolve |
|---|---|---|
| Cliente | nome, razão social, @ (sem o `@`) | `id`, `name`, foto, `instagramHandle`, `archived` |
| Conteúdo | título | `id`, `clientId`, `clientName`, `title`, `format`, `status` e os derivados (atrasado, agendado), `publishOn` |
| Arquivo | nome do arquivo (não removido) | `id`, `clientId`, `clientName`, `folderId`, `name`, o tipo, `thumbnailAssetId` quando houver |

O nome do arquivo vem de [`2026-11-11-estrutural-a-midia-ganha-nome-dimensoes-texto-alternativo-renomear-e-mover`](../docs/business/decisions/2026-11-11-estrutural-a-midia-ganha-nome-dimensoes-texto-alternativo-renomear-e-mover.md); a mídia sem nome (anterior a ela) não casa.

## 4. Estados e transições

Sem estado persistido. O que a busca respeita:

- **Cliente arquivado** aparece, marcado. **Conteúdo cancelado** aparece, com o estado. **Arquivo removido** (`removed_at`) e **não confirmado** não aparecem.
- O termo é comparado **sem acento e sem diferenciar maiúsculas**, com o mesmo dobramento que a carteira e a Equipe já usam.

## 5. Regras invioláveis

1. A busca **nunca** devolve algo de **outra agência**, e nunca de um grupo cuja permissão a pessoa não tem.
2. A busca roda **sob a RLS**, com a pessoa ligada na transação, como as demais leituras. **Nenhuma função `security definer`** a atende.
3. A resposta de quem **não pode ler** um grupo é igual, no formato, à de quem pode e não achou nada: a busca não serve de oráculo de nomes.
4. O termo é **limpo** (aparado, de 2 a 80 caracteres, o mínimo contado nos caracteres buscados, isto é, depois de tirar os acentos e o `@` do começo, que marca o campo e não é caractere buscado; sem caractere de controle) e **parametrizado**: nunca concatenado no SQL, e o `%` e o `_` do termo valem como texto.
5. O termo **não vai para log** (pode ser nome de cliente) nem para métrica.
6. Há limite de requisições por pessoa (proposta: 60 por minuto, com `429` e `Retry-After`), porque é uma leitura que varre três tabelas.
7. Os itens por grupo têm teto (proposta: 6) e a ordem é estável: nome mais próximo do começo primeiro, depois alfabética.

## 6. Backend

### Rotas

| método | rota | permissão | devolve |
|---|---|---|---|
| `GET` | `/agencies/:agencyId/search?q=` | vínculo com a agência; cada grupo por permissão própria | `{ data: { clients, contents, files }, meta: { q } }`; grupo sem permissão vem `[]` |

Contrato proposto (em `packages/contracts/src/search.ts`): `q` obrigatório, 2 a 80 caracteres, `.strict()`; resposta com os três grupos sempre presentes. Erros: `400 VALIDATION_ERROR` para termo curto, longo ou com controle; `429 RATE_LIMITED`.

### Persistência

Nenhuma tabela nova. Módulo da API: `apps/api/src/modules/search`, que **só lê**; não importa arquivos internos de outro módulo, e as consultas passam pelas leituras que cada módulo exporta ou por SQL parametrizado do próprio módulo sobre as tabelas já protegidas pela RLS.

### RLS

Nenhuma policy nova. A prova é de ausência: com uma pessoa sem `conteudo.visualizar`, as policies de `contents` e `media_assets` já devolvem zero linhas; a busca não as contorna.

## 7. Frontend

### Telas

| tela | rota | o que mostra | quem acessa |
|---|---|---|---|
| Busca da agência | painel sobre qualquer tela da agência (Ctrl K) | campo "Buscar cliente, conteúdo ou arquivo" e os grupos de resultado | quem vê ao menos um grupo |
| Busca do portal | campo na casca do portal | "Buscar um post" | pessoa do portal |

### Esboço — agência

```
┌─ topo ──────────────────────────────────────────────────────────────────┐
│ [ 🔍 Buscar cliente, conteúdo ou arquivo        Ctrl K ]   🔔   ? │
└─────────────────────────────────────────────────────────────────────────┘
   ┌───────────────────────────────────────────────────────────┐
   │ padar                                                  ✕ │
   │ Clientes                                                  │
   │  (PC) Padaria Central   @padariacentral                   │
   │ Conteúdos                                                 │
   │  Promoção de pães   Padaria Central · Reels · Aprovado    │
   │ Arquivos                                                  │
   │  (▣) padaria-fachada.jpg   Padaria Central · Foto         │
   └───────────────────────────────────────────────────────────┘
```

| elemento | função |
|---|---|
| Campo em pílula com Ctrl K | abre o painel de qualquer tela; Esc fecha; no celular é um ícone na barra superior |
| Grupo | só os grupos que a pessoa pode ler e que têm resultado |
| Resultado | cliente leva à Visão geral do cliente; conteúdo leva ao calendário do cliente com o conteúdo aberto; arquivo leva à aba Mídias, na pasta dele |
| Teclado | setas movem, Enter abre, Esc fecha; o foco volta ao campo que abriu |

A chamada espera 250 ms depois da última tecla e cancela a anterior. Termo com menos de 2 caracteres buscados (depois de tirar os acentos e o `@` do começo) não chama a API; a tela conta com `searchedCharacters` do pacote de contratos, a mesma função da rota, para não receber `400` enquanto a pessoa digita (`@a` ainda está abaixo do mínimo).

### Esboço — portal

O campo "Buscar um post" (sem Ctrl K) está na casca. Ele **não chama a API**: filtra pelo **título** os posts que a tela de Conteúdos já carregou (o mês aberto). De outra tela, digitar leva a Conteúdos com o termo no endereço (`?busca=`), e a lista abre já filtrada. Sem resultado: "Nenhum post encontrado para «…»", com "Limpar a busca".

### Variação por papel

| quem | o que muda |
|---|---|
| Admin, Owner, Gestor de conta, Produção | os três grupos |
| Vendas, Financeiro | só Clientes; o placeholder continua o mesmo |
| Pessoa do portal | só o filtro do navegador |

### Estados da tela

- **Vazio** (termo ainda não digitado): dicas curtas ("Digite o nome de um cliente, de um conteúdo ou de um arquivo"), sem mascote.
- **Sem resultado:** "Nada encontrado para «…»", com "Limpar a busca". Não distingue "não existe" de "você não pode ver".
- **Carregando:** linhas em skeleton; revalidar não pisca.
- **Erro:** "Não foi possível buscar", com "Tentar de novo"; `429` diz para esperar um instante.
- **Sem permissão:** não é estado: o grupo não aparece.

## 8. Infraestrutura

Nenhum job, armazenamento ou e-mail. A busca é uma leitura síncrona.

## 9. Impacto estrutural

- [ ] altera tabela que já existe
- [x] muda formato de resposta que outras rotas copiam (a resposta por grupos, que a busca do mobile e uma futura "ver todos" vão copiar)
- [ ] mexe em RLS de mais de um módulo (lê três módulos, mas **sem tocar** nenhuma policy)
- [ ] muda como a autorização é avaliada
- [ ] exigiria backfill

Não é estrutural pelas condições de [structural-changes.md](../docs/business/structural-changes.md), mas é **risco Alto** pelo `AGENTS.md` (lê vários módulos e devolve nomes de clientes): pede revisão de segurança independente, com o ataque "o que a pessoa sem permissão consegue inferir".

## 10. Em aberto

| ponto | gatilho | quem decide |
|---|---|---|
| "Ver todos" por grupo, com paginação | a primeira agência com mais de cem clientes ou de mil conteúdos reclamar de resultado cortado | Pedro Vidal |
| Buscar pessoas da equipe e conversas | o primeiro pedido de achar uma pessoa ou conversa pela barra | Pedro Vidal |
| Índice de apoio (trigrama) para a busca | a medição mostrar a busca acima de 200 ms numa agência real | Pedro Vidal |
| Busca no servidor para o portal | o primeiro cliente com mais de um mês de posts que reclame de não achar um post antigo | Pedro Vidal |

## 11. Decisões registradas

- [`2026-11-11-busca-na-agencia-e-no-portal`](../docs/business/decisions/2026-11-11-busca-na-agencia-e-no-portal.md)
- [`2026-11-11-ajuda-e-um-menu-com-rever-o-tour-e-o-status-do-sistema`](../docs/business/decisions/2026-11-11-ajuda-e-um-menu-com-rever-o-tour-e-o-status-do-sistema.md) (a Ajuda fica ao lado da busca na barra)
- [`2026-11-13-agencia-suspensa-nao-usa-a-busca`](../docs/business/decisions/2026-11-13-agencia-suspensa-nao-usa-a-busca.md) (a agência suspensa recebe o mesmo `404` das demais rotas)
- Herdadas: [`2026-10-14-navegacao-da-agencia-sem-ajustes-ate-existir-a-tela`](../docs/business/decisions/2026-10-14-navegacao-da-agencia-sem-ajustes-ate-existir-a-tela.md) (nenhum controle sem destino).

## 12. Recorte de implementação

Ainda não recortado em issues (o dono decidiu, em 2026-11-11, que a onda do redesenho não abre issue). Quando for recortado, a seção 12 recebe os números.

**History:** achar um cliente, um conteúdo ou um arquivo pela barra.

| task | escopo | depende de |
|---|---|---|
| Rota `GET /agencies/:agencyId/search`, contrato e testes de permissão e de oráculo | `api` | o nome do arquivo (decisão da mídia) · **feita** na subtarefa W9-S1 (ver abaixo) |
| Painel de busca, Ctrl K e componente `Kbd` | `web` | a rota |
| Filtro "Buscar um post" no portal | `web` | a casca do portal |

**Registro da rota (W9-S1, 2026-11-13).** O que o recorte fechou, sem regra de negócio nova:

- O contrato mora em `packages/contracts/src/agency-search.ts` (e não em `search.ts`, que já guarda o filtro de texto de outras listagens e é importado por `clients.ts`: um import de `contents.ts` ali fecharia um ciclo). O módulo é `apps/api/src/modules/search`.
- "Mais próximo do começo" é: o nome exibido que **começa** com o termo vem antes do que só o **contém**; dentro de cada faixa, o nome dobrado em ordem alfabética (`collate "C"`) e o `id`. Cliente achado só pela razão social ou pelo @ entra na segunda faixa.
- Os derivados do conteúdo saem como `overdue` e `scheduled`, lidos no relógio de São Paulo pelas mesmas definições do pacote de contratos. A foto do cliente sai como `photoUrl` assinada, só quando a chave é a do avatar daquele cliente.
- O limite de 60 por minuto é por pessoa e único para todas as agências dela; a recusa da barreira de acesso (404) não conta.
- A agência **suspensa** (`status = 'suspended'`) é fechada pela guarda de acesso à agência para toda rota, a busca incluída (`404`); só a agência em somente leitura (teste encerrado) busca. Foi decisão do dono em 2026-11-13 (seção 11): a guarda fica como está, e a busca não abre exceção para a suspensa.
- O mínimo de 2 caracteres do termo vale **depois de tirar os acentos** e, quando o termo começa com `@`, depois de tirar o `@`: um termo só de marcas combinantes, uma letra com acento ou um `@` com uma marca fica abaixo do mínimo e recebe o mesmo `400` de um termo curto. A conta é `searchedCharacters`, do pacote de contratos (a rota e a tela usam a mesma função), porque o banco busca o que sobra da dobra; o esquema do contrato mede só o que foi digitado.
- Sem índice de apoio e sem migration. Medição (13/11/2026, banco local, `EXPLAIN ANALYZE` como `ageniza_app`, uma agência com 500 clientes, 30 mil conteúdos e 30 mil arquivos): clientes 14 ms; conteúdos de 1,0 a 1,2 s; arquivos de 0,9 a 1,0 s, a busca inteira em torno de 2 s. O gatilho de 200 ms da seção 10 **dispara nesse volume**, e a causa não é a dobra do texto (33 ms para os 30 mil títulos): é a avaliação, linha a linha, da policy `contents_select` e da de `media_assets` (`has_agency_permission` + `client_agency_id`, cerca de 33 µs por linha, medidos sozinhos em 980 ms), que o Postgres roda antes de qualquer filtro da consulta. Um índice de trigrama não a evita; o ganho está em tornar a policy barata (mudança de RLS, estrutural, fora desta rota). O custo cresce com o número de conteúdos e arquivos **da própria agência**: algo como 3 mil de cada fica perto de 100 ms. Isso só vale porque a consulta de arquivos leva a agência também na linha de `media_assets` (`asset.agency_id`, além da do cliente): só pela junção com `clients`, o planejador podia varrer os arquivos de todas as agências e avaliar a policy em cada um, e o custo de uma agência passava a seguir o volume das outras (revisão de segurança de 13/11/2026: de 15 ms para 1,6 s com 30 mil arquivos em outra agência). Com o filtro, o plano usa `media_assets_agency_status_idx` (custo estimado de 17 304 para 22,7 no teste de plano, com 30 mil arquivos em outra agência). A de conteúdos sai de `clients` filtrado pela agência (`contents` não tem coluna de agência) e a de clientes filtra a própria tabela.
