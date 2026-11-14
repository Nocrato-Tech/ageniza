# Portal do cliente

O portal é usado pela pessoa do cliente que tem conta, no contexto `client`. Todas as rotas começam com `/clients/:clientId`, que nas tabelas aparece como `…`. Para quem não tem vínculo com aquele cliente, elas respondem `404`. Corpo, resposta e erros de cada rota estão na [referência da API](../../api/README.md).

## Quem acessa

- Qualquer pessoa com **acesso ativo** ao cliente. Ela não tem papel: todas as pessoas de um cliente podem as mesmas coisas.
- Um colaborador da agência, mesmo o Owner, só entra no portal se tiver um acesso próprio àquele cliente.
- O acesso é dado pela agência ([Pessoas do portal](agencia.md#pessoas-do-portal-do-cliente)) ou por convite ([Entrada](entrada.md#convite)).
- Quando o acesso é removido, as sessões da pessoa são encerradas, e a próxima chamada dela recebe `401`.
- Com o cliente arquivado, o portal fica inacessível (`404`). Ele volta se a agência reativar o cliente.

## Rotas

No detalhe de um conteúdo aprovado, **Desfazer aprovação** abre uma confirmação. Confirmar chama `POST …/contents/:contentId/withdraw-approval` com `{ revision }` e devolve o conteúdo para aguardando aprovação, sem mudar legenda, mídias ou revisão. Qualquer pessoa ativa daquele portal pode fazê-lo. Não aparece para publicado, agência ou modo leitura. O servidor recusa revisão desatualizada e serializa com publicação e arquivamento. A repetição na mesma revisão já aguardando aprovação não cria outro evento. Links de aprovação sem conta não oferecem essa ação. Decisão: [cancelamento de aprovação](../../business/decisions/2026-11-06-cliente-pode-desfazer-aprovacao-antes-da-publicacao.md).

| método | rota | o que faz |
|---|---|---|
| `GET` | `…` | cadastro do próprio cliente e o resumo do Início |
| `POST` | `…/onboarding/seen` | marca o primeiro acesso |
| `GET` | `…/brand-study` | estudo de marca e personas ativas (só leitura) |
| `GET` | `…/contents` | conteúdos de um período |
| `GET` | `…/contents/awaiting-approval` | o que espera aprovação |
| `GET` | `…/contents/:contentId` | um post |
| `GET` | `…/contents/:contentId/media/:assetId/url` | URL assinada de uma mídia do post |
| `GET` | `…/contents/:contentId/sender-photo` | a foto de quem da agência enviou a rodada do post, como a imagem (não é JSON); `404` sem foto ou sem acesso |
| `POST` | `…/contents/:contentId/approve` | aprova; o corpo aceita o `note` opcional (recado à agência, até 500 caracteres); com recado em conteúdo que já está aprovado, `409` `CONTENT_ALREADY_APPROVED`, exceto o reenvio da mesma requisição (veja o passo 4) |
| `GET` | `…/contents/progress` | o progresso do mês para a "Boa notícia" do Início: `{ data: { month, approved, total, next } }`; `month` é `AAAA-MM` (o mês de hoje em São Paulo), `total` são os conteúdos do mês que não foram cancelados e `approved`, os aprovados e publicados; `next` é o próximo post a ir ao ar (`{ id, title, publishOn, publishAtTime }`, com `publishAtTime` `null` se o aprovado não tem hora) ou `null` quando não há |
| `POST` | `…/contents/:contentId/request-changes` | pede ajuste (comentário obrigatório); vale para o post aguardando aprovação e para o aprovado até a véspera da data de publicação; fora disso, `409` `CONTENT_NOT_AWAITING_APPROVAL` |
| `GET` | `…/threads` | conversas de um assunto |
| `POST` | `…/threads` | abre uma conversa com o primeiro comentário |
| `GET` | `…/threads/:threadId/comments` | comentários |
| `POST` | `…/threads/:threadId/comments` | comenta |
| `GET` | `…/material-requests` | pedidos de material abertos deste cliente (e a página "Pedidos da agência") |
| `POST` | `…/material-requests/:threadId/uploads` | inicia o envio de uma foto ou áudio a um pedido aberto: reserva o arquivo e devolve a URL assinada de `PUT` (uma parte só) |
| `POST` | `…/material-requests/:threadId/uploads/:assetId/complete` | confirma o envio depois do `PUT` (sem corpo): `200` com o arquivo, ou `422` `UPLOAD_REJECTED` com `details.reason` |
| `GET` | `…/material-requests/:threadId/uploads` | os arquivos que a própria pessoa enviou a este pedido, com a URL assinada de leitura dos confirmados |
| `POST` | `…/material-requests/:threadId/uploads/announce` | avisa o pedido de que o lote foi enviado: `{ assetIds }` (de 1 a 20); grava o comentário "enviou 3 fotos" do cliente |
| `GET` | `…/story-scripts` | roteiros enviados de um período |
| `POST` | `…/story-scripts/:scriptId/recorded` | marca o roteiro como gravado |

## Início

1. `GET …` traz o cadastro do cliente (inclusive a cidade) e o resumo do Início.
2. No primeiro acesso, mostre as boas-vindas e chame `POST …/onboarding/seen`.

**O Início (2026-11-11, [decisão](../../business/decisions/2026-11-11-o-inicio-do-portal-segue-o-quadro-e-a-conversa-continua-no-post.md))**

- A pessoa vê a data, "Olá, <nome>" e um subtítulo ("A <agência> espera N respostas suas"). O rótulo de contexto é "Com a <agência>", **acima** do nome do cliente, e o papel "Aprova os posts" fica no rodapé da navegação.
- **Com posts esperando a aprovação:** até **três capas** com "Aguardando você" ou "Atrasado" (a data de publicação já passou) e "Responda até <dia>, <hora>" (o prazo de aprovação, com hora); "Revisar os N posts" ("Começamos pelo que vence primeiro"), que abre o que vence primeiro e encadeia o próximo; e "A agência pediu" (os pedidos de material abertos).
- **Sem nada esperando:** o bloco **"Boa notícia"**: "Seu feed de <mês> já está N% aprovado", "N de M" (M são os conteúdos do mês que não foram cancelados; N, os aprovados e publicados) e o próximo post a ir ao ar ("hoje às 18h: <título>"), com "Ver o que vai ao ar esta semana".
- **Sai "Nesta semana".** A semana do portal começa no domingo.
- **O "Roteiro de hoje" fica**, como um bloco compacto **abaixo do quadro**, só quando há roteiro enviado ou gravado do dia de São Paulo (ver "Roteiros de stories"): "Já gravei" nos enviados e "Gravado por {nome} em dd/mm" nos gravados. Tirar o "Já gravei" seria perda de função (decisão de 2026-11-11).
- **Navegação:** Início, Conteúdos, Marca e **Pedidos da agência** (com o selo dos pedidos abertos). **Relatórios não existe mais.** Na barra superior da tela larga há o campo "Buscar um post" (sem Ctrl K), que filtra no aparelho, pelo título, os posts do mês que a tela de Conteúdos já carregou (de outra tela, leva a Conteúdos com `?busca=`); sem resultado diz "Nenhum post encontrado para «…»". "Rever o tour" fica no menu **Ajuda**, e o menu de conta tem "Conta" (nome, e-mail e sessões, ver [Entrada](entrada.md#sessões-ativas)), trocar de cliente e "Sair".

## Aprovar conteúdos

1. O que espera a pessoa: `GET …/contents/awaiting-approval`.
2. O calendário de um período: `GET …/contents`.
3. Para abrir um post, use `GET …/contents/:contentId`. As mídias vêm por URL assinada de curta duração; se expirar, peça outra.
4. Para decidir, chame `approve` (com o `note` opcional: o **recado do cliente à agência**, que vira comentário do cliente na conversa do conteúdo, na mesma transação), ou `request-changes` com comentário. Se outra pessoa do cliente já aprovou o post e o `approve` leva um recado, a resposta é `409` com o código `CONTENT_ALREADY_APPROVED` e a mensagem "Este conteúdo já foi aprovado. Seu recado não foi enviado.": mostre a mensagem, recarregue o post e **não repita a chamada**; o recado não foi gravado. **Reenviar a mesma requisição é sucesso** (2026-11-12, [decisão](../../business/decisions/2026-11-12-reenviar-o-mesmo-recado-ao-aprovar-conta-como-sucesso.md)): se a mesma pessoa que aprovou manda de novo o mesmo `revision` e o mesmo recado, sem contar os espaços das pontas (clique duplo, nova tentativa depois de a rede cair), a resposta é a `200` da aprovação, sem segundo comentário nem segunda notificação; o app pode repetir a chamada sem tratar erro. Qualquer diferença (outra pessoa, outro recado, outra `revision`) segue o `409`. O link do e-mail não leva recado e não ganha isso. Sem recado, aprovar um post já aprovado continua respondendo `200`, sem mudar nada ([decisão](../../business/decisions/2026-11-11-recado-em-conteudo-ja-aprovado.md)).

**Buscar um post.** A busca do portal não tem rota: quem digita no campo "Buscar um post" filtra, pelo título (sem distinguir acento nem maiúscula), os posts do mês aberto que `GET …/contents` já devolveu. O termo fica no endereço da tela de Conteúdos (`?busca=`), então a lista abre filtrada ao recarregar, e digitar em outra tela do portal leva a Conteúdos com o termo. Sem resultado: "Nenhum post encontrado para «…»", com "Limpar a busca". No aplicativo, filtre a lista que já carregou; não chame a API.

**O post (2026-11-11).** O post tem a trilha "Início > título", a etiqueta grande "Aguardando sua aprovação", a linha "Carrossel · 5 imagens · publica na sexta, 13 nov, às 12h" (o estado agendado não existe no portal: ele mostra "Aprovado" com a data e a hora), o painel **"Sua resposta"** (com "Responda até <dia>, <hora> · Falta 1 dia"), o recado da agência **com o remetente** e o campo **"Seu recado para a agência"** (opcional). "Aprovar o post" é a ação principal do painel e "Pedir ajuste" a secundária; no celular a barra de decisão fica fixa. O texto diz "Ao aprovar, a agência é avisada e cuida da publicação": o produto **não** agenda nem publica sozinho. **A conversa continua no post**, recolhida abaixo dele: ali o cliente lê as respostas da agência e o recado que deu ao aprovar. Aprovar gera a notificação "o cliente aprovou" para a agência, e pedir ajuste, a de "pediu ajuste".

**Regras**
- Uma pessoa basta para aprovar, e fica registrado quem aprovou. Quando duas aprovam juntas, vale a primeira; a segunda, se levou um recado, recebe o `409` acima (o recado dela não é gravado).
- Aprovar leva o conteúdo a "Aprovado". Pedir ajuste leva a "em ajuste", e a agência reenvia depois de ajustar.
- **Pedir ajuste num post já aprovado (2026-11-13, [decisão](../../business/decisions/2026-11-13-o-cliente-pede-ajuste-depois-de-aprovar-ate-a-vespera-da-publicacao.md)).** O post aprovado mostra "Pedir ajuste" enquanto a data de publicação (`publishOn`) é **depois de hoje**, no dia de São Paulo; no dia da publicação, ou depois, o botão não aparece (a hora de publicação não conta: só o dia). É a mesma chamada, `request-changes` com a `revision` lida e o comentário obrigatório. O post vai a "em ajuste" e a aprovação cai: mostre-o como um post em ajuste, sem "Aprovado", e o recado que o cliente deixou ao aprovar continua na conversa. Se o dia virou entre abrir o post e enviar, ou se a agência mudou a data para hoje, a resposta é `409` `CONTENT_NOT_AWAITING_APPROVAL` com a mensagem "Este conteúdo não aceita mais pedido de ajuste: ele vale até a véspera da publicação.": mostre a mensagem, recarregue o post e **não repita a chamada**. Se a agência mudou a legenda, a mídia, a capa ou o formato, o post voltou a aguardar com uma revisão nova, e a chamada com a revisão antiga responde `409` `CONTENT_REVISION_CHANGED`. O link de aprovação do e-mail não ganha isso: ele só pede ajuste do que aguarda aprovação, e um aprovado responde `409` `CONTENT_NOT_AWAITING_APPROVAL` com "Só um conteúdo aguardando aprovação recebe um pedido de ajuste."
- Se a agência mudar a legenda, a mídia, a capa ou o formato de um conteúdo aprovado, ele volta a esperar aprovação.

**O que o portal vê de cada conteúdo**

| estado | o portal vê |
|---|---|
| em produção | só título, data e tipo |
| aguardando aprovação, em ajuste, aprovado, publicado | também a legenda e a mídia, e `approval` com o prazo e o recado da agência |

**Prazo e recado da agência** (decisão de 2026-11-10)

- Quando a agência envia o conteúdo para aprovação, pode dar um prazo e um recado. O portal lê os dois em `approval`: `{ dueAt, dueOn, note, sentAt, sentBy }`, na lista de um período, na lista do que espera aprovação, no post e na resposta de aprovar, pedir ajuste e desfazer aprovação ([decisão de 2026-11-11](../../business/decisions/2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md)). Os cinco campos vêm sempre; cada um pode ser `null`.
- `dueAt` é o **instante** limite da decisão (data e hora; a API o devolve em UTC, e a tela o mostra no fuso de São Paulo), e `dueOn` é o **dia** de São Paulo desse instante (`AAAA-MM-DD`), para a conta de "vence hoje", "vence amanhã" e "venceu há N dias", que se conta em dias de São Paulo. `note` é o texto da agência. Os três são `null` quando a agência não deu. `approval` é `null` quando o conteúdo ainda está em produção e quando ele já aguardava antes das rodadas (nesse caso, não mostre prazo nem recado). O prazo que estava gravado como dia vale até 23h59 daquele dia.
- Mostre o prazo como o limite da **aprovação** ("Responda até quinta, 12 nov, 18h"; "Falta 1 dia"), diferente da data de publicação do post. O recado vem da agência: mostre o texto como veio, sem interpretá-lo.
- **Quem enviou (2026-11-11, [decisão](../../business/decisions/2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md)):** o portal vê o **nome** e a **foto** (`sentBy: { name, photoUrl }`) e a **data de envio** (`sentAt`) de quem da agência enviou, ao lado do recado ("Recado de João Pereira, da Agência Horizonte"); o e-mail, o cargo, o papel e o identificador do colaborador **nunca chegam**, e o lote também não. `sentBy` é `null` quando a rodada não tem remetente legível. Sem recado, mostre só o prazo. O link de aprovação do e-mail (sem conta) responde só o dia (`dueOn`) e o recado: ali `dueAt`, `sentAt` e `sentBy` vêm `null`.
- **A foto de quem enviou não é um endereço do armazenamento.** `photoUrl` é o **caminho de uma rota do próprio portal**, relativo à API: `/clients/:clientId/contents/:contentId/sender-photo`, e vem `null` quando quem enviou não tem foto (ou quando a rodada não tem remetente). Para mostrar a foto, peça esse caminho **com a sessão da pessoa** (o mesmo cabeçalho de autenticação das outras rotas do portal) e use a resposta, que é o corpo da imagem (`image/png`, `image/jpeg`, `image/gif` ou `image/webp`, conforme os bytes; `Cache-Control: private`), por exemplo como imagem local do aparelho. A rota **não aceita chamada sem sessão** e responde sempre o mesmo `404` quando não há foto, quando o post não é deste cliente, quando a pessoa não tem acesso ao cliente e quando a foto não pôde ser lida: mostre então as iniciais do nome. Não guarde nem monte o caminho a partir de outros dados: use o que a API devolveu. O endereço assinado do armazenamento, que trazia o identificador da conta de quem enviou na própria URL, deixou de existir.
- Se o cliente desfaz a aprovação, o conteúdo volta à mesma rodada e o portal lê o mesmo prazo e o mesmo recado. Se a agência reenvia depois de um pedido de ajuste, vale o prazo e o recado do novo envio.
- O cliente recebe o e-mail do envio com o prazo e o recado, e dois lembretes por rodada: "vence amanhã" (na véspera do prazo) e "venceu" (no dia seguinte), às 9h de São Paulo, só para as pessoas ativas do portal e só enquanto o conteúdo aguarda decisão. Não sai nada com o cliente arquivado nem com a agência suspensa ou em modo leitura, e não sai "vence amanhã" se o envio foi feito na véspera do prazo.

O portal **nunca** vê subtarefa, responsável, prazo interno nem roteiro em rascunho. A API não devolve esses dados. O prazo da aprovação (`approval.dueAt`) não é prazo interno: é o que a agência pediu ao cliente.

## Estados vazios

Uma lista do portal sem nada tem três formas (decisão de 2026-11-10, [três tipos de estado vazio](../../business/decisions/2026-11-10-tres-tipos-de-estado-vazio.md)), e cada uma diz uma coisa só:

- **Primeiro uso:** a agência ainda não compartilhou nada ("Nenhum post planejado para esta semana", "Sua agência ainda está preparando o estudo da sua marca").
- **Boa notícia:** "Nada para aprovar", só quando a consulta respondeu e nada espera a decisão da pessoa. Ela fala só de aprovação: um pedido de material tem o seu bloco.
- **Falha:** a consulta não respondeu. A tela mostra o **mascote sério** (desde 2026-11-11, também no portal), diz isso e oferece "Tentar de novo" e, quando a agência tem contato de suporte, "Avisar o suporte" com o código do erro; nunca "nada para aprovar" nem "nenhum post".

## Conversas

- A pessoa abre conversas e comenta, mas não as resolve. Só a agência resolve.
- Um comentário novo reabre uma conversa resolvida.
- Num conteúdo, só dá para comentar a partir de "aguardando aprovação".
- Comentário não se edita nem se apaga.

### Pedido de material

A agência pode pedir material ao cliente, com prazo opcional (decisão: [pedido de material](../../business/decisions/2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente.md)). No Início, o portal mostra o que a agência pediu.

1. `GET …/material-requests` lista os pedidos **abertos deste cliente**, o prazo mais próximo primeiro e os sem prazo por último, vinte por página. Cada item traz `threadId`, `title` (desde 2026-11-11, obrigatório nos pedidos novos; o pedido anterior vem sem título, e a tela usa o começo do texto), `body` (o texto que a agência escreveu, para mostrar como "A agência pediu"), `dueOn` (`AAAA-MM-DD` ou `null`; a tela diz "até <data>" e "atrasado" quando o dia passou), `createdAt` e `state` (sempre `open`). O portal **não** diz quem da agência abriu o pedido ([título](../../business/decisions/2026-11-11-estrutural-o-pedido-de-material-ganha-titulo.md)).
2. Quem tem acesso a mais de um cliente vê, em cada Início, só os pedidos daquele cliente.
3. Para responder, comente com `POST …/threads/:threadId/comments`, usando o `threadId` do item. O histórico da conversa vem de `GET …/threads/:threadId/comments`, que também serve para um pedido já resolvido. As ações do pedido são **"Responder"** (comentário), **"Enviar fotos"**, **"Gravar depoimento"** e "Ver o pedido" (a página "Pedidos da agência", `/portal/:clienteId/pedidos`, que lista os pedidos abertos e o selo da navegação conta).

**Enviar material pelo portal (2026-11-11, [decisão](../../business/decisions/2026-11-11-estrutural-o-cliente-envia-material-pelo-portal.md))**

- O cliente envia **fotos** (imagem) e **áudio** (um depoimento gravado no próprio navegador ou um arquivo de áudio) **só em resposta a um pedido de material aberto** do cliente dele. Não há biblioteca de mídia no portal, nem envio sem pedido, nem vídeo, PDF ou SVG.
- O envio usa o fluxo de upload direto da agência, sempre em **uma parte só**, em três chamadas por arquivo. Limites: **25 MB por arquivo e 20 arquivos por pedido**; os arquivos contam na cota de armazenamento da agência, sem que o portal saiba disso.
  1. `POST …/uploads` com `{ fileName, contentType, declaredSizeBytes }` devolve `{ assetId, category, contentType, upload: { type: 'single', url, expiresAt } }`. O app faz `PUT` dos bytes em `upload.url`, com o `Content-Type` igual ao `contentType` devolvido (o tipo de uma gravação do navegador, `audio/webm;codecs=opus`, vale; o parâmetro não conta). A URL não é para guardar: vale até `expiresAt`.
  2. `POST …/uploads/:assetId/complete`, sem corpo, confirma. A API lê o arquivo: o **tipo real** (pelos primeiros bytes) tem de ser o declarado, o tamanho tem de caber nos 25 MB e uma foto tem de ter dimensões válidas. Deu certo: `200 { assetId, status: 'confirmed', sizeBytes, contentType }`. Deu errado: `422` `UPLOAD_REJECTED` com `details.reason` em `empty_object` (o arquivo não chegou ou veio vazio), `content_type_mismatch`, `too_large`, `invalid_dimensions`, `request_full` ou `agency_unavailable`. Numa recusa a reserva é liberada e o arquivo é apagado: o app **recomeça pelo passo 1**.
  3. Ao fim do lote, `POST …/uploads/announce` com `{ assetIds }` (os ids confirmados, de 1 a 20, sem repetir) grava **um** comentário do cliente no pedido, com o texto montado pelo servidor ("enviou 3 fotos", "enviou 1 áudio", "enviou 2 fotos e 1 áudio"); `201` com o comentário. Qualquer id que não seja um arquivo confirmado da própria pessoa naquele pedido é `404`, sem dizer qual. Avisar o mesmo lote duas vezes são dois comentários.
- `GET …/uploads` lista só o que **a própria pessoa** enviou àquele pedido (`pending` ou `confirmed`, do mais antigo ao mais novo, 48 por página). Cada item traz `id`, `status`, `category`, `contentType`, `sizeBytes`, `name`, `width`, `height`, `createdAt` e `url`: a URL assinada de leitura do arquivo confirmado (o áudio sai como download) e `null` no pendente. A URL vale poucos minutos; peça a lista de novo em vez de guardar. Nunca vem a chave do arquivo no armazenamento.
- O arquivo cai na pasta de sistema **"Enviados pelo cliente"** do cliente, ligado ao pedido, e a agência o vê no pedido e na aba Mídias ("Enviada por <nome do cliente>"). O comentário do aviso gera a notificação para a agência. O cliente **não apaga nem edita** depois de enviado e só lê o que ele mesmo enviou no pedido.
- Com a agência sem espaço ou em somente leitura, o portal recebe a mensagem neutra de sempre ("A aprovação está pausada no momento. A agência já foi avisada."), nunca plano, cota nem cobrança: `409` `UPLOAD_UNAVAILABLE` (sem espaço, ao iniciar), `409` `AGENCY_READ_ONLY` (somente leitura), ou, ao confirmar, a razão `agency_unavailable`. Pedido resolvido é `409` `REQUEST_RESOLVED`; pedido de outro cliente, que não é de material, cliente arquivado, agência suspensa e vínculo removido são o mesmo `404`. Tipo fora da lista (SVG, PDF, vídeo) é `415`, arquivo declarado acima de 25 MB é `413` e o pedido com 20 arquivos é `409` `REQUEST_FULL`.
4. Só a agência resolve. Quando ela resolve, o pedido **sai da lista**. Se o cliente comentar de novo num pedido resolvido, ele volta, como em toda conversa.
5. Sem pedido aberto, o bloco "A agência pediu" **não aparece**: ele é opcional e não diz que não há nada pendente. Se a consulta falhar, o bloco mostra a falha com "Tentar de novo", e só ele.

- A pessoa do portal **não abre** pedido de material: a rota de abrir conversa responde `400` a esse assunto.
- O pedido não entra em "com resposta da agência" do resumo do Início.
- A conversa de um conteúdo em produção não chega ao portal por nenhuma dessas rotas.

## Estudo de marca

É só leitura. A persona excluída pela agência deixa de existir, com a conversa dela, e não há mais persona arquivada. Com a conversa da persona aberta, se a agência a excluiu, a conversa responde `404`: o app lê o estudo de novo, fecha a conversa e avisa "Essa persona foi removida pela agência.". A persona não traz `status` nem a contagem de mensagens da agência. Desde 2026-11-11 a persona traz também idade, ocupação, local, traços, "onde está" e "tom que funciona" (todos opcionais), lidos como o resto da persona.

## Roteiros de stories

1. `GET …/story-scripts` lista os roteiros que a agência **enviou**; rascunhos não aparecem.
2. Depois de gravar, a pessoa marca o roteiro com `POST …/story-scripts/:scriptId/recorded`.
3. Na web, o roteiro aparece no bloco compacto **"Roteiro de hoje"**, abaixo do quadro do Início (2026-11-11): as cenas em ordem (texto e "Orientação: …") dos roteiros enviados ou gravados do dia; com mais de um no dia, cada um tem o seu título. Sem roteiro hoje, o bloco não existe. Erro ao carregar mostra "Não foi possível carregar o roteiro de hoje." com "Tentar de novo", e o resto do Início continua.

## Agência em modo leitura

Com o teste vencido ou o plano encerrado, o portal continua visível. Aprovar, pedir ajuste e comentar recebem `409 AGENCY_READ_ONLY`.

## Interface Expo

O portal mobile apresenta feed em Geral, calendário e fila de aprovações. Revisar abre legenda, mídias e comentários apenas nos estados permitidos acima. Aprovar e pedir ajuste enviam a revisão lida. Não há seletor de clientes da agência nem kanban no portal. A agência de demonstração usa a API real com dados de exemplo; veja [interface mobile](../interface-mobile.md).


## Ampliação da integração nativa

O portal exige contexto de cliente autenticado. Boas-vindas usam o campo de primeiro acesso e gravam a ciência pela rota `onboarding/seen`. O estudo de marca é somente leitura; conversas não permitem escrita quando a agência está em modo leitura. Nesse caso, com `agencyReadOnly`, o aviso é neutro: "A aprovação está pausada no momento. A equipe de {agência} já foi avisada." Nunca diga ao cliente que o plano da agência precisa ser renovado (decisão 2026-11-06). Roteiros enviados podem ser lidos e marcados como gravados. Tipos de mídia são preservados na prévia de carrosséis mistos. Nenhuma sessão de agência é convertida em sessão de portal pelo aplicativo.


A aba Aprovações do aplicativo usa a rota própria `contents/awaiting-approval`, percorre todas as páginas e não restringe as pendências ao mês do calendário. O feed e o calendário continuam no período escolhido. A lista não inventa legenda, mídias ou revisão; ao abrir, o detalhe atual da API fornece o conteúdo e a revisão que serão usados na decisão.

## Contexto e comunicação no mobile

O cabeçalho identifica o portal do cliente, separado da área da agência. Trocar contexto usa somente vínculos existentes. Aprovar, retirar aprovação e solicitar ajuste mantêm os contratos e a revisão da API; cada resultado comunica a ação confirmada. O calendário preserva o dia selecionado ao voltar da publicação e anuncia quantidade e estados além da cor.

## Acesso ao cliente de exemplo

Na web de desenvolvimento com demonstração habilitada, cada proprietário da própria “Agência Horizonte · Demonstração” pode preparar explicitamente seu acesso ao portal da “Clínica Vida · Exemplo”. A ação usa somente o e-mail verificado da sessão e o cliente encontrado pela API dentro dessa agência; não aceita outro destinatário nem escolhe um identificador arbitrário.

O app reaproveita vínculo ativo, não reativa acesso removido automaticamente e só oferece a entrada após a API devolver o contexto de cliente correspondente. A troca usa o mesmo seletor de contexto autenticado das demais entradas. Qualquer conta verificada pode repetir o fluxo no próprio espaço de demonstração; isso não abre uma agência compartilhada nem altera as permissões do portal.

Para testar: entre na agência de demonstração, abra **Mais → Preparar dados de demonstração → Preparar meu acesso ao portal de exemplo**. Depois da confirmação do servidor, **Entrar no portal de exemplo** usa a seleção autenticada normal. Uma recusa do servidor aparece nesse mesmo cartão, permitindo tentar novamente sem refazer o cadastro.
