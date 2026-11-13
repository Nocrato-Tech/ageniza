# Conteúdo

| | |
|---|---|
| **Status** | aprovado |
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

- **Vendas e Financeiro não veem Conteúdo**, nem o que Clientes mostra derivado dele: a aba Mídias e o botão "Abrir no Calendário Editorial" do detalhe do cliente, os indicadores do card e a ordem da carteira por atraso. Para eles, a carteira mantém a ordem atual.
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
| `removed_at` | timestamptz | não | remoção lógica; o arquivo sai pelo fluxo de retenção, 30 dias depois (seção 8) |
| `purged_at` | timestamptz | não | carimbo da purga: os arquivos saíram do armazenamento e a linha fica para a auditoria; só a função do worker o escreve, e só numa mídia removida |

O upload é do **conteúdo pronto**; o material bruto fica fora do sistema.

**Colunas e tipos novos (2026-11-11, pendentes de validação).** `media_assets` ganha `file_name` (o nome dado no envio, só rótulo: a chave do objeto não muda), `width` e `height` (gravadas no processamento de foto e vídeo), `alt_text` (até 500 caracteres, editável por `conteudo.operar`), a categoria **PDF**, **áudio** e **logo** (SVG só como logo, nunca servido como página nem inline) e, para o envio do cliente pelo portal, a ligação ao pedido de material e o lado de quem enviou. "Quem enviou" já existe (`created_by_user_id`). A agência **renomeia** e **move** o arquivo para outra pasta do mesmo cliente (a regra 12 vale para mover). Só foto e vídeo entram num conteúdo. Decisões: [metadados](../docs/business/decisions/2026-11-11-estrutural-a-midia-ganha-nome-dimensoes-texto-alternativo-renomear-e-mover.md), [tipos](../docs/business/decisions/2026-11-11-estrutural-a-midia-aceita-pdf-audio-e-svg-como-logo.md), [onde é usada e "Usar em um conteúdo"](../docs/business/decisions/2026-11-11-estrutural-a-midia-mostra-onde-e-usada-e-pode-abrir-um-conteudo.md) e [envio pelo cliente](../docs/business/decisions/2026-11-11-estrutural-o-cliente-envia-material-pelo-portal.md). **Upload pelo portal:** a pessoa ativa envia imagem e áudio **só a um pedido de material aberto do cliente dela**, para a pasta de sistema "Enviados pelo cliente", e só lê o que ela enviou; conta na cota da agência, e a mensagem de cota ou de somente leitura é neutra (nunca fala de plano).

### Material enviado pelo cliente — `media_assets` (colunas novas) e as funções do envio

Camada de banco da decisão [`2026-11-11-estrutural-o-cliente-envia-material-pelo-portal`](../docs/business/decisions/2026-11-11-estrutural-o-cliente-envia-material-pelo-portal.md) (validada pelo dono em 2026-11-12), migration `20261113000100_portal_material_uploads`. Sem backfill: a mídia que existe fica sem pedido e do lado `agency`.

| campo | tipo | obrigatório | regra |
|---|---|---|---|
| `material_request_thread_id` | uuid | não | o pedido de material a que o arquivo responde; chave estrangeira `(pedido, cliente)` para `client_threads (id, client_id)`, então o arquivo e o pedido são do mesmo cliente; nenhum grant de escrita à aplicação: só a função de envio o escreve |
| `uploaded_by_side` | texto | sim | `agency` (padrão) ou `client`; é `client` se, e só se, há pedido (`media_assets_client_upload_shape`); também sem grant de escrita |

**Tetos finais (a proposta da decisão, confirmada).** **25 MiB** (26 214 400 bytes) por arquivo e **20 arquivos** por pedido, somando os confirmados e as reservas dentro da janela de reserva, de todas as pessoas do cliente; recusado, removido e reserva vencida não contam. A recusa de tamanho vem do banco (413), não do corpo da rota: o contrato aceita até 10 GiB, como o envio da agência. Uma cópia de cada valor no banco (`portal_upload_max_bytes`, `portal_upload_max_files`) e uma em `packages/contracts/src/portal-material-uploads.ts`; o teste de integração do banco lê as do contrato.

**Tipos.** Imagem: PNG, JPEG, WebP e GIF. Áudio: MP3 (`audio/mpeg`), M4A (`audio/mp4`, `audio/x-m4a`), WAV (`audio/wav`, `audio/x-wav`, `audio/wave`), WebM e Ogg. Os parâmetros do tipo (`;codecs=opus`) não contam. Nunca SVG, vídeo nem PDF. A chave do objeto e a extensão são montadas no banco, a partir do tipo e dos ids que ele leu; a pessoa não escolhe nenhuma.

**Pasta de sistema "Enviados pelo cliente".** Uma por cliente, criada pelo primeiro envio (não pelo cliente) como pasta `is_default`. É o mínimo que impede a agência de quebrar a regra, sem policy nova: a agência não a cria à mão (sem grant em `is_default`), não a renomeia (a policy de `UPDATE` exclui `is_default`) e não a apaga (`delete_media_folder` responde A0086, e não há `DELETE`). A agência ainda **move** um arquivo dela para outra pasta, como em qualquer mídia.

**Funções (`security definer`, `search_path` vazio, execução só da aplicação; as três que escrevem recusam outro isolamento que não READ COMMITTED, com 40001).** O ator vem do `bind_actor` da transação, nunca de `auth.uid()`. Os tetos padrão de cota da implantação e a janela de reserva são parâmetros: moram na configuração da API, e um parâmetro ausente ou não positivo dá 22023.

| função | o que faz |
|---|---|
| `start_portal_material_upload(cliente, pedido, tipo, tamanho, nome, cota_bytes_padrão, cota_arquivos_padrão, janela)` | confere a pessoa e o pedido **antes de qualquer trava** (vínculo ativo, cliente ativo, agência ativa, pedido de material do mesmo cliente), depois o tipo e o tamanho; trava a cota da agência, o cliente e o pedido (em `FOR SHARE`) e **relê tudo**: vínculo, pedido aberto, agência que aceita escrita, vaga no pedido e na cota (a vaga na cota pergunta se a agência tem folga para **um arquivo do teto**, 25 MiB, e não para o tamanho declarado: ver abaixo). Grava a linha `pending`, com o tamanho declarado, e devolve as chaves |
| `confirm_portal_material_upload(arquivo, tamanho_real, tipo_real, largura, altura, …)` | o arquivo é da pessoa e está `pending`; mesmas travas e releituras; o veredito sobre os bytes (`empty_object`, `content_type_mismatch`, `too_large`, `invalid_dimensions`, `request_full`, `agency_unavailable`) **grava a recusa** e responde `rejected`, para a reserva não ficar pendurada; senão confirma e carimba o instante. **Nenhum motivo fala de plano, cota nem armazenamento** (item 5 da decisão): a falta de espaço da agência é `agency_unavailable`, o mesmo sentido do A0136 no início (também com a folga medida contra o teto do arquivo, não contra o tamanho real), e é esse o valor gravado, devolvido e declarado no contrato (`PortalMaterialUploadRejectionReason`) |
| `reject_portal_material_upload(arquivo, motivo)` | a pessoa solta a própria reserva (objeto que não chegou); o motivo é um código curto em minúsculas. Agência que não aceita escrita responde A0090 neutro, como as outras duas, e não com a mensagem do gatilho da tabela |
| `list_portal_material_uploads(cliente, pedido, limite, posição)` | a **única leitura** do portal (abaixo): uma página dos arquivos que a própria pessoa enviou àquele pedido, do mais antigo ao mais novo, com o id como desempate. Cada linha traz o total (`total_count`) e só as colunas da listagem: `asset_id`, `status`, `category`, `content_type` e `size_bytes` (o tipo e o tamanho lidos dos bytes quando confirmado, os declarados quando pendente), `file_name`, `width`, `height`, `created_at` e `object_key` (a chave **final**, só de arquivo confirmado, para a API assinar a leitura). Nunca a chave do staging, o id do multipart, o texto alternativo nem a pasta. Uma página além do fim (e um pedido sem arquivo) devolve **uma linha com o total e `asset_id` nulo**, para o total não depender de haver página. Limite de 1 a 100 e posição de 0 em diante, senão 22023 |

**A recusa por falta de espaço não depende de nenhum número que a pessoa controla** (limite defensivo, não regra de produto). No início e na confirmação do portal, a pergunta "cabe?" compara a folga da agência (cota menos o uso) com o teto fixo de 25 MiB por arquivo, nunca com o tamanho declarado nem com o real: folga menor que 25 MiB recusa **qualquer** tamanho (A0136 no início, `agency_unavailable` na confirmação), folga de 25 MiB ou mais aceita qualquer tamanho até o teto. Sem isso, a pessoa variaria o tamanho, soltaria a reserva e leria, byte a byte, o espaço que a agência ainda tem e o tamanho do que ela sobe para outros clientes. Pela mesma razão, o uso dessa pergunta **não soma nenhuma reserva pendente do lado do cliente** (de qualquer pessoa do portal, de qualquer cliente da agência), em bytes nem em contagem: a pessoa as cria, dimensiona e solta à vontade, e somá-las revelaria a folga por tentativa. Contam só os arquivos confirmados e as reservas da própria agência. O custo é o portal parar de aceitar quando faltam menos de 25 MiB, em vez de só quando a cota enche, e as reservas do portal não seguram espaço umas contra as outras: na disputa pela última vaga, a segunda pessoa é recusada na confirmação (`agency_unavailable`). A cota não estoura, porque cada confirmação exige folga de um arquivo do teto sob a trava da cota. O caminho da agência continua contando todas as reservas. A reserva e a contabilidade da cota seguem pelo tamanho (declarado na reserva, real na confirmação), e o envio da agência não muda.

Ordem das travas, sempre a mesma: a linha do arquivo (só na confirmação), a trava consultiva `media-quota:<agência>`, o cliente `FOR SHARE` (conflita com o arquivamento) e o pedido `FOR SHARE` (conflita com a resolução). O envio da agência já pega a cota antes do cliente, e nada aqui pega `agency_trial_limits:`, então a ordem das outras funções não muda. A soma de uso do armazenamento tem uma cópia só (`agency_storage_in_use`), que `agency_media_usage` também chama, e o que diz quem é um pedido do portal também (`require_portal_material_request`: vínculo ativo, pedido de material do mesmo cliente, ou A0130), chamado pelo início do envio e pela leitura.

**Leitura.** Por função, não pela tabela (lição do #383: o portal não lê tabela de mídia direto): o portal **não tem `SELECT`** em `media_assets` (nenhuma policy sua), e `list_portal_material_uploads` devolve o arquivo `client` que a própria pessoa enviou a um pedido, `pending` ou `confirmed`, não removido, enquanto ela tiver vínculo ativo com o cliente ativo de uma agência ativa; fora disso, A0130 (a leitura não exige que o pedido esteja aberto nem que a agência aceite escrita). Nunca o arquivo de outra pessoa, de outro cliente, de outra agência nem a mídia da agência, e nunca `upload_object_key`, `multipart_upload_id`, `alt_text` nem a pasta. A pessoa do portal não tem `INSERT`, `UPDATE` nem `DELETE` em `media_assets`. A agência lê os arquivos do cliente pela regra de sempre da biblioteca (`conteudo.visualizar`): quem só tem `cliente.visualizar` (Vendas) vê o comentário do pedido, mas não o arquivo.

| código | HTTP | quando |
|---|---|---|
| A0130 | 404 | pedido, arquivo ou vínculo não encontrado: pedido de outro cliente, conversa que não é pedido de material, cliente arquivado, agência suspensa, vínculo removido, arquivo de outra pessoa. **Uma resposta só**, que não revela qual |
| A0131 | 409 | o pedido está resolvido |
| A0132 | 413 | o arquivo passa do teto |
| A0133 | 415 | o tipo não está na lista |
| A0134 | 409 | o pedido já tem os 20 arquivos |
| A0135 | 409 | o envio não está mais pendente |
| A0136 | 409 | a agência não pode receber o arquivo agora (armazenamento, folga menor que um arquivo do teto): **neutra**, a API mostra a mensagem do portal que não fala de plano, cota nem cobrança. Na confirmação a mesma situação é o motivo `agency_unavailable` |
| A0090 | 409 | agência em somente leitura: o código que já existe (`AGENCY_READ_ONLY`), com a mesma mensagem neutra, nas três funções que escrevem |

Fica na API, não no banco: ler os bytes do objeto e deduzir o tipo e as dimensões, copiar do staging para a chave final, assinar as URLs, auditar (`media.upload_initiated`, `media.upload_confirmed`, `media.upload_rejected`) e comentar o pedido ("enviou 3 fotos").

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

**Mídias do conteúdo — `content_media`:** `content_id`, `asset_id`, `position`. Imagem e cada vídeo: 1 item; carrossel: 2 a 20, imagem ou vídeo, ordenados. Só mídias da pasta do conteúdo. **A pasta é como um drive** (decisão de 2026-11-04, [`2026-11-04-a-pasta-e-como-um-drive-...`](../docs/business/decisions/2026-11-04-a-pasta-e-como-um-drive-o-conteudo-herda-a-midia-e-troca-de-pasta.md)): ao escolher a pasta o conteúdo herda, uma vez, a mídia que serve ao formato; mídia que entra na pasta depois não entra sozinha; trocar a pasta é permitido e substitui a lista e a capa (a capa volta a nenhuma), com o efeito da troca de mídia sobre a aprovação; a pasta nova vazia deixa um conteúdo em produção sem mídia e é recusada (`CONTENT_MEDIA_INCOMPLETE`) para um que aguarda ou está aprovado. Isso substitui a trava de pasta (`CONTENT_FOLDER_IN_USE`) e o envio só pela visão Pastas.

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
aprovado ────────────▶ aguardando aprovação   # pessoa ativa do portal desfaz a aprovação; exige revisão lida, antes de publicar (#850)
```

- **Agência e portal dizem "Aprovado"** (2026-11-11, [`2026-11-11-agendado-e-um-estado-derivado-de-aprovado-com-data-e-hora-futuras`](../docs/business/decisions/2026-11-11-agendado-e-um-estado-derivado-de-aprovado-com-data-e-hora-futuras.md), que substitui o "pronto para publicar" da agência).
- **Agendado** é derivado: aprovado, com hora de publicação (`publish_at_time`) e o instante `publish_on` + hora (São Paulo) ainda no futuro. Sem hora, é só Aprovado. Não há estado novo nem publicação automática; o portal não usa a palavra Agendado.
- Mudar data, hora, título, responsável ou subtarefas **mantém** a aprovação. Mover de data vale em todos os estados menos publicado e cancelado.
- **Atrasado** é derivado: data planejada passada sem publicado nem cancelado. **Prazo em dois dias** também é derivado. O bloco "Atrasados" do Início conta pela **data de publicação**, e o prazo de aprovação vencido é "venceu há N dias", outra coisa ([`2026-11-11-atrasado-conta-pela-data-de-publicacao-e-parado-no-cliente-segue-a-ordem-de-envio`](../docs/business/decisions/2026-11-11-atrasado-conta-pela-data-de-publicacao-e-parado-no-cliente-segue-a-ordem-de-envio.md)).
- **Rodada de aprovação** (2026-11-10 e 2026-11-11): cada envio abre uma rodada com **prazo com hora** (de agora até 90 dias, padrão proposto pela tela de 48 horas, opcional na API: [`2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas`](../docs/business/decisions/2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas.md)) e recado de até 500 caracteres. O portal vê o **nome, a foto e a data de envio de quem enviou**, nunca o lote, e o cliente pode **aprovar com um recado**, que vira comentário do cliente na conversa do conteúdo ([`2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar`](../docs/business/decisions/2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md)).

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
12. Mídia usada, como arquivo ou como capa, em conteúdo aguardando aprovação, aprovado ou publicado não pode ser removida da pasta. A recusa vale também para "aguardando aprovação", além da leitura literal de "aprovado ou publicado", porque o cliente está olhando o post e a aprovação não confere a mídia de novo (`docs/business/decisions/2026-10-07-remover-midia-e-por-funcao-e-se-recusa-em-conteudo-ja-enviado.md`).
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
| `POST` | `…/media-folders/:folderId/assets/:assetId/remove` | `conteudo.operar` | `409` se usada, como arquivo ou capa, em conteúdo aguardando aprovação, aprovado ou publicado (regra 12) |
| `PATCH` | `…/media/:assetId` | `conteudo.operar` | renomeia (`name`) e edita o texto alternativo (`altText`); *proposta* |
| `POST` | `…/media/:assetId/move` | `conteudo.operar` | move para outra pasta do mesmo cliente (`folderId`); `409` se em uso (regra 12); *proposta* |
| `GET` | `…/media/:assetId/usage` | `conteudo.visualizar` | os conteúdos que usam o arquivo (título e estado); *proposta* |
| `GET` | `…/clients/:clientId/media?q=` | `conteudo.visualizar` | os arquivos do cliente por ordem de envio, com filtro pelo nome; *proposta* |
| `POST` | `/agencies/:agencyId/clients/:clientId/story-scripts` | `conteudo.operar` | `201` com o roteiro em rascunho |
| `GET` | `/agencies/:agencyId/clients/:clientId/story-scripts/:scriptId` | `conteudo.visualizar` | o roteiro, em qualquer estado, com as cenas |
| `PATCH` | `…/story-scripts/:scriptId` | `conteudo.operar` | o roteiro |
| `POST` | `…/story-scripts/:scriptId/send` | `conteudo.operar` | enviado |

O upload de mídia reaproveita o fluxo existente (`/agencies/:agencyId/media/uploads`), acrescido de cliente e pasta. Comentários do conteúdo reaproveitam as rotas de conversa do cliente, com `content_id`. A agência pode comentar durante a produção; o portal vê a conversa quando o conteúdo é disponibilizado. Conteúdo cancelado não aceita comentários (decisão de 2026-11-07, issue #876).

### Rotas do portal

Todas sob `requireSession` e `requireClientAccess`.

| método | rota | devolve |
|---|---|---|
| `GET` | `/clients/:clientId/contents` | conteúdos de um período, no recorte do portal |
| `GET` | `/clients/:clientId/contents/awaiting-approval` | o que precisa de você |
| `GET` | `/clients/:clientId/contents/:contentId` | o post com legenda e mídias a partir de "aguardando aprovação" |
| `POST` | `/clients/:clientId/contents/:contentId/approve` | aprovado; corpo com `revision` e, opcional, `note` (até 500 caracteres), que vira comentário do cliente na conversa do conteúdo na mesma transação |
| `GET` | `/clients/:clientId/home-progress` | o progresso do mês (aprovados, total e o próximo a ir ao ar) para a "Boa notícia" do Início; *proposta* |
| `POST` | `/clients/:clientId/material-requests/:threadId/uploads` | inicia o envio de uma imagem ou áudio a um pedido aberto, pelo mesmo fluxo de upload direto (iniciar, confirmar), sempre em uma parte só; corpo e resposta em `CreatePortalMaterialUpload*` (`packages/contracts`); recusas na tabela de códigos da seção 3; *proposta* |
| `POST` | `/clients/:clientId/material-requests/:threadId/uploads/:assetId/complete` | confirma o envio depois do `PUT`; sem corpo; devolve o arquivo confirmado, ou a recusa que o banco gravou (`PortalMaterialUploadRejectionReason`: nenhum valor fala de plano, cota nem armazenamento; a falta de espaço da agência chega como `agency_unavailable`); *proposta* |
| `GET` | `/clients/:clientId/material-requests/:threadId/uploads` | os arquivos que a própria pessoa enviou a este pedido (`pending` e `confirmed`), paginado, por `list_portal_material_uploads` (seção 3); a rota monta a URL assinada de leitura com `object_key` dos confirmados e não devolve a chave; *proposta* |
| `POST` | `/clients/:clientId/contents/:contentId/request-changes` | em ajuste; comentário obrigatório |
| `GET` | `/clients/:clientId/story-scripts` | roteiros enviados de um período |
| `POST` | `/clients/:clientId/story-scripts/:scriptId/recorded` | gravado |

### Consulta por período

Calendário e a aba Feed em tela cheia consultam por intervalo (`from`, `to`), com **teto de 93 dias** e teto de itens; acima disso, 400. Não pagina. Os dois extremos entram: 93 dias passam e 94 não. O teto de itens é 500, somando conteúdos e roteiros, e a resposta é `{ data: { contents, storyScripts }, meta: { from, to, count } }` ([decisão](../docs/business/decisions/2026-10-11-consulta-por-periodo-teto-de-500-itens-e-formato-da-resposta.md)). É o formato que Tarefas (kanban) e Dashboard vão copiar; listas continuam no contrato paginado. O celular ao lado do calendário tem leitura própria, `GET …/contents/feed`: o feed inteiro do cliente por cursor de nove em nove, na ordem do feed (dia, hora e id, do maior para o menor), com os contadores do feed inteiro.

### Persistência

Tabelas novas: `media_folders`, `contents`, `content_media`, `content_tasks`, `story_scripts`, `story_script_scenes` e a fila de notificação. Colunas novas: `media_assets.client_id`, `media_assets.folder_id`, `media_assets.removed_at`, `media_assets.purged_at`, `client_threads.content_id`, e, no envio do cliente pelo portal, `media_assets.material_request_thread_id` e `media_assets.uploaded_by_side` (mais a chave única `(id, client_id)` de `client_threads`, para a chave estrangeira composta). Permissões novas no catálogo, com os presets da seção 2. Pastas padrão criadas para todos os clientes existentes (backfill) e no cadastro de cada cliente novo.

### RLS

- **Agência:** isolamento por `client_id` → agência, com `app_private.has_agency_permission(agência, 'conteudo.<ação>')`.
- **Portal:** `is_client_member(client_id)` para conteúdo a partir de "aguardando aprovação" (em produção, só as colunas de planejamento, por função de leitura), roteiro enviado e mídia **lida através do conteúdo** visível; o arquivo que a própria pessoa enviou a um pedido de material é lido só pela função `list_portal_material_uploads` (o portal não tem `SELECT` em `media_assets`) e escrito só pelas funções do envio (seção 3), sem `INSERT`, `UPDATE` nem `DELETE` do portal.
- **Nenhuma** tabela de trabalho interno (`content_tasks`) tem policy que um vínculo de cliente satisfaça.
- Grants por coluna; estado, aprovação e gravação só por função; transições e anulação da aprovação por trigger `BEFORE UPDATE` com `OLD`/`NEW`.

## 7. Frontend

### Telas

| tela | rota | o que mostra | quem acessa |
|---|---|---|---|
| Calendário Editorial | `/agencia/:agenciaId/conteudos` | seletor de clientes em stories | `conteudo.visualizar` |
| Calendário Editorial do cliente | `/agencia/:agenciaId/conteudos/:clienteId` | seletor Mês, Semana e Feed (`?visao=`); no Mês e na Semana, o calendário na largura toda, com a semana começando no **domingo**, **capa no card** e os chips de filtro (Todos, Em produção, Aguardando, Aprovado, Agendado, Atrasado, Publicado). **Sem o celular ao lado**: o feed é a vista Feed ([`2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco`](../docs/business/decisions/2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco.md)) | `conteudo.visualizar` |
| Modal do conteúdo | `/agencia/:agenciaId/conteudos/:clienteId/:conteudoId` | abas Geral e Atribuição | `conteudo.visualizar` |
| Aba Conteúdos do cliente | `/agencia/:agenciaId/clientes/:clienteId/conteudos` | **a aba volta** (2026-11-11, [`2026-11-11-o-perfil-do-cliente-tem-cinco-abas-e-a-aba-conteudos-volta`](../docs/business/decisions/2026-11-11-o-perfil-do-cliente-tem-cinco-abas-e-a-aba-conteudos-volta.md), que substitui o item 1 de `2026-11-04-o-perfil-do-cliente-nao-tem-copia-do-calendario`): não é um calendário, é a lista dos conteúdos do cliente **por quem precisa agir** (Esperando o cliente, Atrasado, Em produção, Aprovado e agendado), por data ou por formato, com capa, formato, data, quem cuida e estado; "Nova publicação" e "Abrir no Calendário Editorial" levam ao calendário, que segue com um endereço só. `…/conteudos/novo` e `…/conteudos/:conteudoId` continuam redirecionando (com `replace`) para `/conteudos/:clienteId` | `conteudo.visualizar` (sem ela, "não encontrado") |
| Aba Mídias do cliente | `/agencia/:agenciaId/clientes/:clienteId/midias` | as pastas e as mídias do cliente, com o envio; o endereço antigo `…/conteudos/:clienteId?vista=pastas` leva para cá | `conteudo.visualizar` (escrever: `conteudo.operar`) |
| Portal — Conteúdos | `/portal/:clienteId/conteudos` | o que precisa de você, calendário, feed | pessoa do portal |
| Portal — post | `/portal/:clienteId/conteudos/:conteudoId` | post em tela cheia com a trilha "Início > título", "Sua resposta" (prazo com hora, "Falta N dias"), o recado da agência com **quem enviou**, "Seu recado para a agência", "Aprovar o post", "Pedir ajuste" e a **conversa recolhida** abaixo | pessoa do portal |
| Portal — Início | `/portal/:clienteId` | data e "Olá, <nome>", até **três capas** dos posts que esperam, "Revisar os N posts" (abre o que vence primeiro e encadeia o próximo), "A agência pediu"; sem pendência, a "Boa notícia" com o progresso do mês. **Sem "Nesta semana"**; o bloco compacto **"Roteiro de hoje" com "Já gravei" continua abaixo do quadro**, quando há roteiro enviado ou gravado do dia ([`2026-11-11-o-inicio-do-portal-segue-o-quadro-e-a-conversa-continua-no-post`](../docs/business/decisions/2026-11-11-o-inicio-do-portal-segue-o-quadro-e-a-conversa-continua-no-post.md)) | pessoa do portal |
| Portal — Pedidos da agência | `/portal/:clienteId/pedidos` | os pedidos de material abertos, com título, prazo, "Responder", "Enviar fotos" e "Gravar depoimento" | pessoa do portal |
| Link de aprovação | `/aprovar#<token>` (fora da casca; o fragmento é apagado ao abrir) | o lote do e-mail: o celular de cada post, Aprovar, Pedir ajuste (comentário obrigatório) e "Criar conta para ver o portal" com o e-mail preenchido | quem tem o link (7 dias), sem conta |

### Esboço — agência

**Intenção:** Produção e Gestor de conta, todo dia, no desktop, para planejar o mês de um cliente e fechar o que falta para ir ao ar. Mesa editorial: o mês do cliente à vista, o travado saltando aos olhos.

```
┌───────────────────────────────────────────────────────────────────┐
│ ( ◉ )  ( ◉ )  ( ○ )  ( ○ )  ( ○ )   ← clientes em stories         │
│ Padaria Ótica  Café   Moda   Pet       anel = algo pedindo ação   │
├───────────────────────────────────────────────────────────────────┤
│ ‹ Outubro 2026 ›  [Mês|Semana|Feed]            [+ Novo conteúdo]  │
│ [Todos 16] [Em produção 5] [Aguardando 2] [Aprovado 4] [Agendado 2]│
│ [Atrasado 1] [Publicado 2]                                         │
│                                                                   │
│ dom  seg  ter  qua  qui  sex  sáb      (semana começa no domingo) │
│      ┌─────┐       ┌─────┐                                        │
│      │ capa │      │ capa │  +                                    │
│      │título│      │título│                                       │
│      │reels │       │⚠ 2/4 │                                      │
│      └─────┘       └─────┘                         stories ●      │
└───────────────────────────────────────────────────────────────────┘
```

| elemento | função |
|---|---|
| Clientes em stories | foto ou ícone e nome; ordem da carteira; anel destacado quando há em ajuste, atraso ou prazo em dois dias; só ativos |
| Calendário | seletor **Mês, Semana e Feed** (`?visao=semana` e `?visao=feed`; o mês é o padrão); criar pelo botão ou pelo **+** do dia (Conteúdo ou Roteiro de stories); arrastar o card para outra data |
| Card | **com capa** (a miniatura; sem capa, o ícone do formato), ícone do formato, título e a etiqueta de estado; o alerta de prazo ou atraso e o percentual das subtarefas ficam no cartão do passar do mouse; um toque em qualquer ponto abre o conteúdo e o dia cheio mostra **+N**. Substitui o "sem capa" do item 3 de `2026-11-04-calendario-editorial-tem-mes-semana-e-feed-card-sem-capa-e-celular-so-na-tela-larga` ([`2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco`](../docs/business/decisions/2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco.md)); a legenda sob o calendário diz "O formato tinge o card; o estado fica na etiqueta" |
| Chips de filtro | Todos, Em produção (que inclui Em ajuste), Aguardando, Aprovado, Agendado, Atrasado e Publicado, com a contagem; Atrasado atravessa os outros |
| Detalhe ao passar o mouse | começo da legenda, responsável, resumo das subtarefas, última mensagem da conversa |
| Feed | **O celular ao lado do calendário saiu** (2026-11-11, `2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco`, que substitui o item 4 de `2026-11-04-calendario-editorial-…` e `2026-11-04-o-celular-do-calendario-mostra-o-feed-inteiro-do-cliente` nesse ponto): o feed é a vista **Feed** do seletor, e o aparelho com os nove quadros é o desenho dessa vista no celular do cliente (moldura com @, avatar, "N no período / N prontos / N aguardando" e a legenda "Como ler o feed"). O texto abaixo descreve o aparelho e a rota de leitura do feed, que continuam. Antes, o celular ao lado do calendário, desenhado como um aparelho, com a grade de **3 colunas** dos conteúdos de feed não cancelados do **cliente inteiro, sem relação com o mês ou a semana abertos no calendário** (decisão `2026-11-04-o-celular-do-calendario-mostra-o-feed-inteiro-do-cliente`): abre no post mais recente, como um perfil real, e rola de verdade (roda, toque e teclado) dentro da tela do aparelho, que tem altura fixa; os próximos nove carregam ao chegar perto do fim, e a última linha pode ficar incompleta, sem quadro vazio. As setas **para cima e para baixo** movem uma tela (nove posts, três linhas) com rolagem suave (sem animação com `prefers-reduced-motion`) e só ficam travadas no começo ou no fim reais do feed. Os contadores do perfil (posts, prontos, aguardando) contam o feed inteiro e vêm da API. Vídeo longo e VSL só no calendário. Criar, editar, mover de data e cancelar atualizam o feed. O celular só aparece a partir de 48 rem de largura; abaixo disso fica escondido e o caminho é a vista **Feed** do seletor, que mostra o período em tela cheia, trinta por página (decisão `2026-11-04-calendario-editorial-tem-mes-semana-e-feed-card-sem-capa-e-celular-so-na-tela-larga`, que traz a vista Feed de volta e substitui nesse ponto a de 2026-10-16) |
| Mídias | a biblioteca do cliente fica na aba Mídias do detalhe do cliente (`specs/clientes.md`, seção 7); subir mídia antes de existir o post (ensaio fotográfico). Em 2026-11-11 a mídia ganhou nome, dimensões e texto alternativo, renomear e mover, PDF, áudio e SVG (logo), "onde é usada" e "Usar em um conteúdo", e o cliente passou a enviar material pelo portal (seção 3) |

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
│ Início  Conteúdos  Marca  Pedidos(2)
└───────────────────────────┘
```

- Card: capa, título, a etiqueta do formato e a etiqueta da situação (aprovado, aguardando aprovação, em ajuste, em produção, publicado), tingido pelo formato como o do calendário da agência; o dia é o rótulo do grupo. Sem capa, o ícone do formato. Filtro por status.
- Post em tela cheia: legenda inteira, mídias navegáveis, **Pedir ajuste** (pede comentário), **Aprovar** e a conversa. Os dois botões ficam numa barra fixa no pé da tela, que no celular toma o lugar da barra inferior de quatro itens; o caminho de volta é o link "Conteúdos" no topo (decisão `2026-10-15-post-do-portal-troca-as-abas-pela-barra-de-decisao`). Em produção, só título, data e formato.
- Início (2026-11-11): até **três** capas dos posts que esperam, "Revisar os N posts" e "A agência pediu"; sem pendência, a "Boa notícia" ("Seu feed de novembro já está 70% aprovado", N de M, o próximo post a ir ao ar). **Sai** "Nesta semana". **O roteiro de stories de hoje, com o "Já gravei", fica** num bloco compacto abaixo do quadro, só quando há roteiro do dia. A semana do portal também começa no domingo. A navegação passa a ser Início, Conteúdos, Marca e **Pedidos da agência** (com o selo de pedidos abertos); **Relatórios sai**. A busca do portal é o filtro "Buscar um post" ([`busca.md`](busca.md)).
- A **conversa continua no post**, recolhida abaixo; ali o cliente lê as respostas da agência e o recado que deu ao aprovar. A barra de ação fixa no pé (Aprovar o post como a principal, Pedir ajuste) vale também no celular.
- **Roteiro de stories no portal:** o "Roteiro de hoje" continua no Início, abaixo do quadro (decidido em 2026-11-11: tirar o "Já gravei" seria perda de função), com as regras de [`2026-10-11-portal-inicio-aprovacoes-e-roteiro-de-hoje`](../docs/business/decisions/2026-10-11-portal-inicio-aprovacoes-e-roteiro-de-hoje.md): cenas em ordem, rascunho nunca aparece, "Já gravei" nos enviados e "Gravado por {nome} em dd/mm" nos gravados.

### Variação por papel

| quem | o que muda |
|---|---|
| Admin, Owner | tudo |
| Gestor de conta | tudo |
| Produção | opera e publica; sem Aprovar pela agência, sem Cancelar |
| Vendas, Financeiro | o item Calendário Editorial, a aba Mídias e o botão "Abrir no Calendário Editorial" do perfil não existem; carteira sem indicadores de conteúdo |
| Pessoa do portal | aprova (com recado opcional), pede ajuste, comenta a partir de aguardando aprovação; envia material ao pedido aberto da agência. marca o roteiro de hoje como gravado, no Início |

### Estados da tela

- **Vazio:** calendário vazio com Criar para quem opera; feed com os nove quadros "nada neste dia" e "planeje o primeiro post"; no portal, "Nenhum conteúdo planejado para este mês" (com "Ir para este mês" quando o mês aberto não é o de hoje), o filtro sem resultado com "Limpar o filtro" e o feed sem post dos formatos do feed com "Ver a lista".
- **Carregando:** skeleton na primeira carga; revalidação não muda a tela.
- **Erro:** mensagem com Tentar de novo.
- **Sem permissão:** o item não aparece no menu, e a URL digitada cai no mesmo "não encontrado".

## 8. Infraestrutura

- **E-mail ao cliente** por uma **fila de notificação** enviada pelo worker, para todas as pessoas ativas do portal: "conteúdos para aprovar" agrupado com espera de 15 minutos após o último envio; "publicado" em resumo diário. Nada para cliente arquivado ou agência suspensa.
- **Link de aprovação sem login** (2026-10-26, [decisão](../docs/business/decisions/2026-10-26-estrutural-o-e-mail-de-aprovacao-leva-um-link-que-aprova-sem-login.md)): cada e-mail "conteúdos para aprovar" leva um link próprio da pessoa, válido por 7 dias, que abre só os conteúdos do lote, com a prévia de celular, Aprovar e Pedir ajuste. O token vai no fragmento (`#`) e é trocado por um cookie de sessão de aprovação; as respostas saem com `no-store` e as mídias da prévia por URL assinada de minutos. A decisão é registrada como aquele acesso ao portal, nas colunas de autoria que apontam para o acesso. A revogação é conferida a cada leitura e a cada decisão: acesso ativo, cliente não arquivado, agência não suspensa e aceitando escrita. O link guarda a geração do acesso, e reativar o acesso não ressuscita um link antigo. Com o trial vencido, o worker para os e-mails da agência, e a retenção continua. As pessoas com acesso ao portal e sem conta também recebem o e-mail (decisão de 2026-10-26 sobre o acesso ao portal por e-mail).
- **Cancelamento** do conteúdo além da data de encerramento **dentro da função de arquivar o cliente** (job e rota), no molde de `archive_due_clients`.
- **Mídia**: o upload direto e o processamento de vídeo existentes; o quadro automático serve de capa quando não há capa enviada; a remoção lógica entra no fluxo de retenção.
- **Retenção da mídia removida** ([decisão](../docs/business/decisions/2026-10-11-midia-removida-sai-do-armazenamento-30-dias-depois-e-a-linha-fica.md), pendente do dono): um job diário do worker (`media.purge-removed`), 30 dias depois do `removed_at`, apaga do armazenamento o objeto, a chave de envio e a miniatura e o preview de vídeo, e carimba `purged_at`; a linha fica para a auditoria. Nunca toca mídia em uso por conteúdo aguardando aprovação, aprovado ou publicado (regra 12). A cota deixa de contar o que foi purgado e continua contando o que só foi removido. O banco é `app_private.media_due_for_purge` e `app_private.mark_media_purged`; o job é `apps/worker/src/media-purge-job.ts`.

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
| Preferências de notificação por tipo, e e-mail ou push | a primeira pessoa pedir para silenciar um tipo, ou para ser avisada fora do app (a notificação **dentro do app** passou a existir em 2026-11-11: [`notificacoes.md`](notificacoes.md)) | Pedro Vidal |
| Atrasados e "Aprovados no mês" com histórico (hoje é a contagem de agora) | o primeiro pedido de ver o mês fechado | Pedro Vidal |
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

Registradas em 2026-11-11 (todas **pendentes de validação do dono**; o quadro do redesenho): [Agendado derivado e "Aprovado"](../docs/business/decisions/2026-11-11-agendado-e-um-estado-derivado-de-aprovado-com-data-e-hora-futuras.md), [prazo com hora](../docs/business/decisions/2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas.md), [atrasado e ordem de "Parado no cliente"](../docs/business/decisions/2026-11-11-atrasado-conta-pela-data-de-publicacao-e-parado-no-cliente-segue-a-ordem-de-envio.md), [remetente e recado ao aprovar](../docs/business/decisions/2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md), [notificações](../docs/business/decisions/2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos.md), [busca](../docs/business/decisions/2026-11-11-busca-na-agencia-e-no-portal.md), [abas do cliente](../docs/business/decisions/2026-11-11-o-perfil-do-cliente-tem-cinco-abas-e-a-aba-conteudos-volta.md), [visual](../docs/business/decisions/2026-11-11-o-visual-segue-o-quadro-r0-semana-no-domingo-capa-no-card-e-uma-primaria-por-bloco.md), as quatro de mídia (metadados, tipos, uso, envio pelo cliente), [Início do portal](../docs/business/decisions/2026-11-11-o-inicio-do-portal-segue-o-quadro-e-a-conversa-continua-no-post.md) e [Início da agência](../docs/business/decisions/2026-11-11-o-inicio-da-agencia-mostra-aprovados-no-mes-agendados-e-passos-com-data-e-nome.md).

Registrada depois, em 2026-10-11: [SPEC de Conteúdo aprovada, com o recorte de implementação](../docs/business/decisions/2026-10-11-spec-de-conteudo-aprovada-com-o-recorte.md). Ela registra a aprovação desta SPEC e está pendente de validação do dono.

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
