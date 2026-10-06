# Conteúdo

| | |
|---|---|
| **Status** | em revisão |
| **Submódulos** | calendário e feed; conteúdo e aprovação; subtarefas; biblioteca de mídia por cliente; roteiro de stories; portal; e-mail ao cliente |
| **Sessões** | 2026-10-01 |
| **Decidido por** | Pedro Vidal (dono do produto) |

## 1. Propósito

Conteúdo é onde a agência planeja, produz e aprova os posts de cada cliente, e onde o cliente confere e aprova o que vai ao ar. A agência trabalha sobre o mês do cliente — o calendário editorial ao lado de uma prévia do feed do Instagram —, e o cliente entra pelo portal para aprovar ou pedir ajuste. No MVP a publicação na rede social é **manual**: o cliente aprova, a agência publica por fora e marca como publicado.

### Não resolve

- **Publicação automática** na rede social e **métricas**: ficam fora do MVP e decidem juntas, porque usam a mesma conexão com a conta do cliente (2026-09-26).
- **Outras plataformas** além do Instagram: roadmap. O modelo não se amarra ao Instagram (formato e limite são por plataforma).
- **Versões e histórico de alterações** do post, **banco de legendas e hashtags**, **aprovação em várias etapas**.
- **Tarefa avulsa, kanban por cliente e a visão "minhas tarefas"**: módulo Tarefas. Aqui a tarefa nasce sempre ligada a um conteúdo.
- **Biblioteca de mídia no portal** e **comentário no roteiro de stories**: em aberto, com gatilho (seção 10).

## 2. Atores e autorização

| capacidade | permissão | Admin | Gestor de conta | Produção | Vendas | Financeiro |
|---|---|---|---|---|---|---|
| ver calendário, conteúdos, comentários, subtarefas, pastas e roteiros | `conteudo.visualizar` | ✓ | ✓ | ✓ | | |
| criar, editar, mover de data, anexar mídia, gerir pastas, comentar, criar subtarefas, enviar para aprovação, roteirizar stories | `conteudo.operar` | ✓ | ✓ | ✓ | | |
| marcar como publicado e desfazer no mesmo dia | `conteudo.publicar` | ✓ | ✓ | ✓ | | |
| registrar "aprovado fora da plataforma" e substituir o responsável na aprovação de subtarefa | `conteudo.aprovar_pela_agencia` | ✓ | ✓ | | | |
| cancelar conteúdo (fica guardado) | `conteudo.cancelar` | ✓ | ✓ | | | |

> Owner tem acesso total por posse. Visibilidade de menu é UX; a autorização é validada no backend e no banco em toda operação.

- **Vendas e Financeiro não veem Conteúdo**, nem o que Clientes mostra derivado dele: a aba Conteúdos do detalhe do cliente, os indicadores do card e a ordem da carteira por atraso. Para eles, a carteira mantém a ordem atual.
- **Subtarefa** é aprovada pelo **responsável do conteúdo**; quem tem `conteudo.aprovar_pela_agencia` substitui. É autorização dependente do valor (seção 9).
- Quem tem `conteudo.visualizar` vê o conteúdo de **todos** os clientes da agência, como em Clientes.

### A pessoa do portal

Qualquer pessoa **ativa** do portal daquele cliente:

- vê os conteúdos do cliente — em produção, só título, data e tipo; a partir de "aguardando aprovação", legenda e mídia;
- aprova ou pede ajuste (uma pessoa basta; fica registrado quem);
- comenta a partir de "aguardando aprovação";
- vê os roteiros de stories enviados e marca como gravado.

Nunca vê subtarefa, responsável, prazo interno nem roteiro em rascunho.

## 3. Entidades e campos

### Pasta de mídia — `media_folders`

| campo | tipo | obrigatório | regra |
|---|---|---|---|
| `client_id` | uuid | sim | o cliente dono da pasta; não muda |
| `parent_id` | uuid | não | nulo no primeiro nível; preenchido numa pasta de trabalho |
| `name` | texto | sim | |
| `is_default` | booleano | sim | pasta padrão do sistema |

**Pertence a:** cliente (e, por ele, à agência).
**Relações:** **dois níveis** — pasta padrão (ou própria da agência) no primeiro nível e pastas de trabalho dentro dela. Uma pasta guarda N mídias e pode servir a N conteúdos.
**Padrão:** todo cliente nasce com Vídeos, Imagens, Carrosséis e Ensaio fotográfico; a agência pode criar pastas próprias no primeiro nível.

### Mídia — `media_assets` (colunas novas)

| campo | tipo | obrigatório | regra |
|---|---|---|---|
| `client_id` | uuid | não | preenchido na mídia de conteúdo; a mídia anterior fica sem cliente, só da agência |
| `folder_id` | uuid | não | a pasta do mesmo cliente |
| `removed_at` | timestamptz | não | remoção lógica; o arquivo sai pelo fluxo de retenção |

O upload é do **conteúdo pronto**; o material bruto fica fora do sistema.

### Conteúdo — `contents`

| campo | tipo | obrigatório | regra |
|---|---|---|---|
| `client_id` | uuid | sim | |
| `title` | texto | sim | interno, até 120 caracteres; o cliente vê |
| `platform` | texto | sim | `instagram` no MVP |
| `format` | texto | sim | `image`, `carousel`, `reels`, `long_video`, `vsl` |
| `publish_on` | date | sim | data de publicação planejada |
| `publish_at_time` | time | não | hora opcional |
| `caption` | texto | não | até 2.200 caracteres |
| `folder_id` | uuid | sim | pasta do mesmo cliente |
| `cover_asset_id` | uuid | não | capa de vídeo; sem ela vale o quadro automático do worker |
| `owner_user_id` | uuid | sim | responsável; por padrão quem criou |
| `status` | texto | sim | ver seção 4; só por função |
| `approved_by`, `approved_at` | uuid, timestamptz | não | fixados pelo banco |
| `approved_by_agency_reason` | texto | não | obrigatório quando a aprovação é "fora da plataforma" |
| `published_on` | date | não | data real; não futura |
| `cancelled_at` | timestamptz | não | |

**Mídias do conteúdo — `content_media`:** `content_id`, `asset_id`, `position`. Imagem e cada vídeo: 1 item; carrossel: 2 a 20, imagem ou vídeo, ordenados. Só mídias da pasta do conteúdo.

**Pertence a:** cliente.
**Relações:** N conteúdos por cliente; 1 pasta por conteúdo; N mídias ordenadas; N subtarefas; 1 conversa.

### Subtarefa — `content_tasks`

| campo | tipo | obrigatório | regra |
|---|---|---|---|
| `content_id` | uuid | sim | |
| `title` | texto | sim | |
| `description` | texto | não | |
| `assignee_user_id` | uuid | sim | colaborador ativo da agência |
| `due_on` | date | sim | |
| `status` | texto | sim | ver seção 4 |

O **percentual do conteúdo** é a razão entre subtarefas aprovadas e o total; não aparece sem subtarefas.

### Roteiro de stories — `story_scripts` e `story_script_scenes`

| campo | tipo | obrigatório | regra |
|---|---|---|---|
| `client_id` | uuid | sim | |
| `script_on` | date | sim | o dia dos stories |
| `status` | texto | sim | rascunho, enviado, gravado |
| `recorded_by`, `recorded_at` | uuid, timestamptz | não | fixados pelo banco |
| cena: `position`, `text`, `guidance` | inteiro, texto, texto | posição e texto sim; orientação não | cenas ordenadas |

Sem mídia, sem aprovação, sem comentário no MVP.

### Conversa — `client_threads` (coluna nova)

`content_id` uuid, opcional. **Uma conversa por conteúdo**, no formato já decidido do estudo de marca, reaberta quando o cliente comenta.

## 4. Estados e transições

### Conteúdo

```
em produção ─────────▶ aguardando aprovação   # conteudo.operar; exige mídia completa para o formato e todas as subtarefas aprovadas
aguardando aprovação ▶ aprovado               # pessoa ativa do portal; ou conteudo.aprovar_pela_agencia com motivo
aguardando aprovação ▶ em ajuste              # pessoa ativa do portal; exige comentário
em ajuste ───────────▶ aguardando aprovação   # conteudo.operar (reenviar)
aprovado ────────────▶ publicado              # conteudo.publicar; data real não futura
publicado ───────────▶ aprovado               # conteudo.publicar; só no mesmo dia
(qualquer, menos publicado) ▶ cancelado       # conteudo.cancelar; ou o arquivamento do cliente
cancelado ───────────▶ em produção            # conteudo.operar (reagendar)
aprovado ────────────▶ aguardando aprovação   # automático ao mudar legenda, mídia, capa ou formato
```

- Na agência, "aprovado" aparece como **pronto para publicar**; no portal, como **Aprovado**.
- Mudar data, hora, título, responsável ou subtarefas **mantém** a aprovação. Mover de data vale em todos os estados menos publicado e cancelado.
- **Atrasado** é derivado: data planejada passada sem publicado nem cancelado. **Prazo em dois dias** também é derivado.

### Subtarefa

```
pendente ─▶ entregue    # o responsável da subtarefa
entregue ─▶ aprovada    # o responsável do conteúdo; ou conteudo.aprovar_pela_agencia
entregue ─▶ pendente    # devolvida, com comentário
```

Atrasada é derivado: prazo passado sem aprovada.

### Roteiro de stories

```
rascunho ─▶ enviado     # conteudo.operar; passa a aparecer no portal
enviado ──▶ gravado     # pessoa ativa do portal
```

## 5. Regras invioláveis

1. O portal nunca vê trabalho interno: subtarefa, responsável, prazo interno, conteúdo em produção além de título, data e tipo, e roteiro em rascunho — nem pela API.
2. O portal só vê o próprio cliente; quem não tem `conteudo.visualizar` não lê conteúdo, pasta, subtarefa nem roteiro.
3. Conteúdo, pasta e mídia são sempre do mesmo cliente e da mesma agência; um conteúdo só seleciona mídias da própria pasta.
4. `approved_by`, `approved_at`, `recorded_by` e `recorded_at` são fixados pelo banco; aprovar é de pessoa ativa do portal daquele cliente, ou "aprovado fora" com a permissão e motivo.
5. Só as transições da seção 4 existem; nada vai de "em produção" a "aprovado".
6. Mudar legenda, mídia, capa ou formato de um conteúdo aprovado o devolve a "aguardando aprovação".
7. Publicado só a partir de aprovado, com data real não futura; desfazer só no mesmo dia.
8. Cliente arquivado não recebe conteúdo novo e não dispara e-mail; conteúdo com data depois do encerramento vira cancelado no arquivamento e não volta sozinho na reativação. Agência suspensa não dispara e-mail.
9. Conteúdo não é apagado: cancelado continua guardado.
10. Responsável de subtarefa é colaborador ativo da agência; só o responsável do conteúdo, ou quem tem `conteudo.aprovar_pela_agencia`, aprova subtarefa.
11. Enviar para aprovação exige mídia completa para o formato e subtarefas aprovadas; pedir ajuste exige comentário.
12. Mídia usada em conteúdo aprovado ou publicado não pode ser removida da pasta.
13. O cliente comenta só a partir de "aguardando aprovação".
14. Conteúdo de cliente arquivado é só leitura na agência.

## 6. Backend

### Rotas da agência

Todas sob `requireAgencyAccess`; o cliente de `:clientId` precisa pertencer a `:agencyId`, e o conteúdo, ao cliente — senão o mesmo 404.

| método | rota | permissão | devolve |
|---|---|---|---|
| `GET` | `/agencies/:agencyId/clients/:clientId/contents` | `conteudo.visualizar` | conteúdos e roteiros de um período (`from`, `to`) |
| `POST` | `/agencies/:agencyId/clients/:clientId/contents` | `conteudo.operar` | `201` com o conteúdo em produção |
| `GET` | `/agencies/:agencyId/clients/:clientId/contents/:contentId` | `conteudo.visualizar` | o conteúdo com mídias, subtarefas e o resumo da conversa |
| `PATCH` | `/agencies/:agencyId/clients/:clientId/contents/:contentId` | `conteudo.operar` | o conteúdo; anula a aprovação nos campos da regra 6 |
| `POST` | `…/contents/:contentId/submit` | `conteudo.operar` | aguardando aprovação; `409` sem mídia completa ou com subtarefa não aprovada |
| `POST` | `…/contents/:contentId/approve-by-agency` | `conteudo.aprovar_pela_agencia` | aprovado; motivo obrigatório |
| `POST` | `…/contents/:contentId/publish` | `conteudo.publicar` | publicado, com a data real |
| `POST` | `…/contents/:contentId/unpublish` | `conteudo.publicar` | aprovado; `409` fora do mesmo dia |
| `POST` | `…/contents/:contentId/cancel` | `conteudo.cancelar` | cancelado |
| `POST` | `…/contents/:contentId/reschedule` | `conteudo.operar` | em produção |
| `POST` | `…/contents/:contentId/tasks` | `conteudo.operar` | `201` com a subtarefa |
| `PATCH` | `…/contents/:contentId/tasks/:taskId` | `conteudo.operar` | a subtarefa |
| `POST` | `…/tasks/:taskId/deliver` | o responsável da subtarefa | entregue |
| `POST` | `…/tasks/:taskId/approve` | o responsável do conteúdo, ou `conteudo.aprovar_pela_agencia` | aprovada |
| `POST` | `…/tasks/:taskId/return` | o responsável do conteúdo, ou `conteudo.aprovar_pela_agencia` | pendente; comentário obrigatório |
| `GET` | `/agencies/:agencyId/clients/:clientId/media-folders` | `conteudo.visualizar` | pastas do cliente |
| `POST` | `/agencies/:agencyId/clients/:clientId/media-folders` | `conteudo.operar` | `201` com a pasta |
| `GET` | `…/media-folders/:folderId/assets` | `conteudo.visualizar` | mídias da pasta, paginado |
| `POST` | `…/media-folders/:folderId/assets/:assetId/remove` | `conteudo.operar` | `409` se usada em conteúdo aprovado ou publicado |
| `POST` | `/agencies/:agencyId/clients/:clientId/story-scripts` | `conteudo.operar` | `201` com o roteiro em rascunho |
| `PATCH` | `…/story-scripts/:scriptId` | `conteudo.operar` | o roteiro |
| `POST` | `…/story-scripts/:scriptId/send` | `conteudo.operar` | enviado |

O upload de mídia reaproveita o fluxo existente (`/agencies/:agencyId/media/uploads`), acrescido de cliente e pasta. Comentários do conteúdo reaproveitam as rotas de conversa do cliente, com `content_id`.

### Rotas do portal

Todas sob `requireSession` e `requireClientAccess`.

| método | rota | devolve |
|---|---|---|
| `GET` | `/clients/:clientId/contents` | conteúdos de um período, no recorte do portal |
| `GET` | `/clients/:clientId/contents/awaiting-approval` | o que precisa de você |
| `GET` | `/clients/:clientId/contents/:contentId` | o post com legenda e mídias a partir de "aguardando aprovação" |
| `POST` | `/clients/:clientId/contents/:contentId/approve` | aprovado |
| `POST` | `/clients/:clientId/contents/:contentId/request-changes` | em ajuste; comentário obrigatório |
| `GET` | `/clients/:clientId/story-scripts` | roteiros enviados de um período |
| `POST` | `/clients/:clientId/story-scripts/:scriptId/recorded` | gravado |

### Consulta por período

Calendário e feed consultam por intervalo (`from`, `to`), com **teto de 93 dias** e teto de itens; acima disso, 400. Não pagina. É o formato que Tarefas (kanban) e Dashboard vão copiar; listas continuam no contrato paginado.

### Persistência

Tabelas novas: `media_folders`, `contents`, `content_media`, `content_tasks`, `story_scripts`, `story_script_scenes` e a fila de notificação. Colunas novas: `media_assets.client_id`, `media_assets.folder_id`, `media_assets.removed_at`, `client_threads.content_id`. Permissões novas no catálogo, com os presets da seção 2. Pastas padrão criadas para todos os clientes existentes (backfill) e no cadastro de cada cliente novo.

### RLS

- **Agência:** isolamento por `client_id` → agência, com `app_private.has_agency_permission(agência, 'conteudo.<ação>')`.
- **Portal:** `is_client_member(client_id)` para conteúdo a partir de "aguardando aprovação" (em produção, só as colunas de planejamento, por função de leitura), roteiro enviado e mídia **lida através do conteúdo** visível.
- **Nenhuma** tabela de trabalho interno (`content_tasks`) tem policy que um vínculo de cliente satisfaça.
- Grants por coluna; estado, aprovação e gravação só por função; transições e anulação da aprovação por trigger `BEFORE UPDATE` com `OLD`/`NEW`.

## 7. Frontend

### Telas

| tela | rota | o que mostra | quem acessa |
|---|---|---|---|
| Conteúdos | `/agencia/:agenciaId/conteudos` | seletor de clientes em stories | `conteudo.visualizar` |
| Conteúdos do cliente | `/agencia/:agenciaId/conteudos/:clienteId` | calendário, feed 3×3 e Pastas | `conteudo.visualizar` |
| Modal do conteúdo | `/agencia/:agenciaId/conteudos/:clienteId/:conteudoId` | abas Geral e Atribuição | `conteudo.visualizar` |
| Aba Conteúdos do cliente | `/agencia/:agenciaId/clientes/:clienteId/conteudos` | a mesma visão do cliente | `conteudo.visualizar` |
| Portal — Conteúdos | `/portal/:clienteId/conteudos` | o que precisa de você, calendário, feed | pessoa do portal |
| Portal — post | `/portal/:clienteId/conteudos/:conteudoId` | post em tela cheia, Aprovar, Pedir ajuste, conversa | pessoa do portal |
| Portal — Início | `/portal/:clienteId` | "N conteúdos esperando sua aprovação" e o roteiro de hoje | pessoa do portal |

### Esboço — agência

**Intenção:** Produção e Gestor de conta, todo dia, no desktop, para planejar o mês de um cliente e fechar o que falta para ir ao ar. Mesa editorial: o mês do cliente à vista, o travado saltando aos olhos.

```
┌───────────────────────────────────────────────────────────────────┐
│ ( ◉ )  ( ◉ )  ( ○ )  ( ○ )  ( ○ )   ← clientes em stories         │
│ Padaria Ótica  Café   Moda   Pet       anel = algo pedindo ação   │
├──────────────────────────────────────┬────────────────────────────┤
│ ‹ Outubro 2026 ›   [Mês|Semana]      │  @padariacentral           │
│ [+ Criar conteúdo] [Calendário|Feed| │ ┌──┬──┬──┐                 │
│                     Pastas]          │ │  │  │  │  feed 3×3       │
│ seg  ter  qua  qui  sex  sáb  dom    │ ├──┼──┼──┤  mais recente   │
│      ┌─────┐       ┌─────┐           │ │  │  │  │  primeiro;      │
│      │capa │       │capa │  +        │ ├──┼──┼──┤  futuros com    │
│      │título│      │título│          │ │  │  │  │  marca de       │
│      │reels│       │🎬 ⚠ │           │ └──┴──┴──┘  planejado      │
│      │2/4  │       │      │          │                            │
│      └─────┘       └─────┘  stories ●│                            │
└──────────────────────────────────────┴────────────────────────────┘
```

| elemento | função |
|---|---|
| Clientes em stories | foto ou ícone e nome; ordem da carteira; anel destacado quando há em ajuste, atraso ou prazo em dois dias; só ativos |
| Calendário | mês, com opção de semana; criar pelo botão ou pelo **+** do dia (Conteúdo ou Roteiro de stories); arrastar o card para outra data |
| Card | capa, título, formato, data e hora, status, alerta de prazo ou atraso, percentual das subtarefas |
| Detalhe ao passar o mouse | começo da legenda, responsável, resumo das subtarefas, última mensagem da conversa |
| Feed | grade 3×3 dos conteúdos de feed não cancelados, sincronizada com o período; vídeo longo e VSL só no calendário |
| Pastas | biblioteca do cliente; subir mídia antes de existir o post (ensaio fotográfico) |

### Esboço — modal do conteúdo

```
┌─ Geral ─┬─ Atribuição ─────────────────────────────────────────┐
│ ┌───────────────┐  Título  [..........................]       │
│ │  prévia do    │  Formato [Reels ▾]  Data [12/10] Hora [18:00]│
│ │  post ao vivo │  Pasta   [Vídeos / Lançamento ▾] [+ nova]    │
│ │               │  Mídias  [▣][▣][+]   Capa [▣]                │
│ └───────────────┘  Legenda [.................... 1.204/2.200] │
│                                                               │
│ [Enviar para aprovação]  [Aprovar pela agência] [Cancelar]    │
│ ── Conversa ──────────────────────────────────────────────── │
└───────────────────────────────────────────────────────────────┘
```

- **Atribuição:** o responsável e a lista de subtarefas (título, responsável, prazo, estado), com Entregar, Aprovar e Devolver conforme quem olha.
- Os botões seguem o estado e a permissão: Enviar para aprovação, Aprovar pela agência, Marcar como publicado, Desfazer publicação, Cancelar, Reagendar.

### Esboço — roteiro de stories

Modal próprio: data, cenas ordenadas (texto e orientação), adicionar e reordenar cena, **Enviar ao cliente**. O dia com roteiro tem indicador no calendário.

### Esboço — portal

**Intenção:** o dono do negócio, pelo celular, poucas vezes por semana, para conferir e aprovar. O item da barra passa de "Calendário" a **"Conteúdos"**.

```
┌───────────────────────────┐
│ O que precisa de você (3) │
│ ┌─────┐ ┌─────┐ ┌─────┐   │
│ │capa │ │capa │ │capa │   │
│ └─────┘ └─────┘ └─────┘   │
├───────────────────────────┤
│ ‹ Outubro ›  [Calendário|Feed]
│ Filtro: [Todos ▾]         │
│ 12 ter  Reels · Aprovado  │
│ 15 sex  Carrossel · Em ajuste
│ 18 seg  Post · Em produção│
├───────────────────────────┤
│ Início  Conteúdos  Marca  Relatórios
└───────────────────────────┘
```

- Card: capa, título, data e status (aprovado, aguardando aprovação, em ajuste, em produção). Filtro por status.
- Post em tela cheia: legenda inteira, mídias navegáveis, **Aprovar**, **Pedir ajuste** (pede comentário) e a conversa. Em produção, só título, data e formato.
- Início: "N conteúdos esperando sua aprovação" e o roteiro de stories de hoje, com **Marcar como gravado**.

### Variação por papel

| quem | o que muda |
|---|---|
| Admin, Owner | tudo |
| Gestor de conta | tudo |
| Produção | opera e publica; sem Aprovar pela agência, sem Cancelar |
| Vendas, Financeiro | o item Conteúdos e a aba Conteúdos não existem; carteira sem indicadores de conteúdo |
| Pessoa do portal | aprova, pede ajuste, comenta a partir de aguardando aprovação, marca roteiro como gravado |

### Estados da tela

- **Vazio:** calendário vazio com Criar para quem opera; feed com a grade marcada "planeje o primeiro post"; no portal, "Nenhum conteúdo planejado para este mês".
- **Carregando:** skeleton na primeira carga; revalidação não muda a tela.
- **Erro:** mensagem com Tentar de novo.
- **Sem permissão:** o item não aparece no menu, e a URL digitada cai no mesmo "não encontrado".

## 8. Infraestrutura

- **E-mail ao cliente** por uma **fila de notificação** enviada pelo worker, para todas as pessoas ativas do portal: "conteúdos para aprovar" agrupado com espera de 15 minutos após o último envio; "publicado" em resumo diário. Nada para cliente arquivado ou agência suspensa.
- **Cancelamento** do conteúdo além da data de encerramento **dentro da função de arquivar o cliente** (job e rota), no molde de `archive_due_clients`.
- **Mídia**: o upload direto e o processamento de vídeo existentes; o quadro automático serve de capa quando não há capa enviada; a remoção lógica entra no fluxo de retenção.

## 9. Impacto estrutural

- [x] **altera tabela que já existe**
- [x] **muda formato de resposta que outras rotas copiam**
- [x] **mexe em RLS de mais de um módulo**
- [x] **muda como a autorização é avaliada**
- [x] **exigiria backfill**

**É estrutural em sete pontos, registrados antes da implementação** em `decisions.md` ("Conteúdo: impacto estrutural", 2026-10-01):

1. **Mídia com cliente e pasta**: `alter table media_assets` e RLS de mídia lida através do conteúdo — fecha a estrutural "cliente na mídia".
2. **`client_threads.content_id`**: `alter table` na conversa de Clientes e regra de comentário do portal na policy de insert.
3. **Aprovação por atribuição**: aprovar subtarefa depende de ser o responsável do conteúdo — autorização dependente do valor, no banco.
4. **Consulta por período**: formato novo, com teto, que Tarefas e Dashboard vão copiar.
5. **Trabalho sem requisição**: e-mail e cancelamento por funções `security definer` de escopo único; cancelamento dentro da função de arquivar o cliente.
6. **Backfill**: pastas padrão para os clientes existentes.
7. **Fila de notificação**: primeiro mecanismo de notificação, que os próximos tipos reaproveitam.

## 10. Em aberto

| ponto | gatilho | quem decide |
|---|---|---|
| Biblioteca de mídia no portal (navegar e baixar) | o primeiro cliente pedir para baixar o material entregue | Pedro Vidal |
| Comentário no roteiro de stories | o primeiro cliente pedir para comentar o roteiro | Pedro Vidal |
| Pastas padrão por agência | a segunda agência pedir pastas padrão diferentes | Pedro Vidal |
| Vendas ver Tarefas, que mostram o título do conteúdo | a entrevista de Tarefas | Pedro Vidal |
| Outras plataformas | a primeira agência precisar planejar outra rede | Pedro Vidal |
| Publicação automática e métricas | a decisão de publicar pela plataforma (integração com a Meta) | Pedro Vidal |
| Versões do post, banco de legendas, aprovação em várias etapas | o primeiro cliente ou agência pedir | Pedro Vidal |
| Preferências de notificação e notificação dentro do produto | o segundo tipo de notificação entrar na fila | Pedro Vidal |
| Fuso por agência (#153) | a primeira agência fora de `America/Sao_Paulo` | Pedro Vidal |

## 11. Decisões registradas

Em [decisions.md](../docs/business/decisions.md), todas de 2026-10-01:

- Conteúdo: a entrevista abre antes do merge de #123 e #128
- Conteúdo: propósito e fronteiras do MVP
- Conteúdo: atores e autorização
- Conteúdo: entidades e campos
- Conteúdo: pastas de mídia, estados e transições
- Conteúdo: regras invioláveis
- Conteúdo: telas (esboço)
- Conteúdo: impacto estrutural

Herdadas: publicar e medir decidem juntos (2026-09-26); conteúdo além do encerramento é cancelado (2026-09-26); tarefa e prazo interno nunca são dados do portal (2026-09-26); a conversa com o cliente é uma tabela de threads por cliente (2026-09-26); arquivar cliente é função de escopo único (2026-09-26); cliente na mídia fica para Conteúdo (2026-09-26).

## 12. Recorte de implementação

**Épico:** #238.

| history | task | escopo | depende de |
|---|---|---|---|
| #239 Organizar a mídia em pastas | #247 | `db` | #122 |
|  | #253 | `api` | #247 |
|  | #267 | `web` | #253 |
| #240 Planejar no calendário e no feed | #249 | `db` | #247, #123 |
|  | #254 | `api` | #249 |
|  | #262 | `web` | #254 |
|  | #263 | `web` | #254 |
|  | #264 | `web` | #253, #254, #256 |
| #241 Subtarefas | #255 | `api` | #249 |
|  | #265 | `web` | #255 |
| #242 Aprovar com o cliente | #250 | `db` | #249, #128 |
|  | #256 | `api` | #249 |
|  | #257 | `api` | #250 |
|  | #259 | `api` | #250, #128, #130 |
|  | #266 | `web` | #259 |
|  | #269 | `web` | #257, #141 |
|  | #270 | `web` | #257, #259 |
| #243 Publicar, cancelar e encerramento | #251 | `db` | #249, #123 |
| #244 Roteiro de stories | #248 | `db` | #247 |
|  | #258 | `api` | #248 |
|  | #268 | `web` | #258, #262 |
|  | #271 | `web` | #257, #258, #141 |
| #245 E-mail ao cliente | #252 | `db` | #249 |
|  | #260 | `infra` | #252, #256 |
| #246 Sinais em Clientes e no portal | #261 | `api` | #254, #125, #129 |
|  | #272 | `web` | #261, #262, #134, #136 |

**Em aberto:** #273 · #274 · #275 · #276 · #277 · #278 — e, já existentes, #149 (publicação automática e métricas), #146 (notificação) e #153 (fuso por agência).

**Débitos:** nenhum por enquanto.

### A ordem que a dependência impõe

Tudo depende de #122, #123 e #128 mergeadas. Banco primeiro: #247 (permissões e pastas) destrava #249 (conteúdo) e #248 (stories); #249 destrava #250, #251 e #252. Depois as APIs, e as telas por último. Cada migration vai num PR sozinho.
