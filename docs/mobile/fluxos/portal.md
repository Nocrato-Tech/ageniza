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
| `POST` | `…/contents/:contentId/approve` | aprova |
| `POST` | `…/contents/:contentId/request-changes` | pede ajuste (comentário obrigatório) |
| `GET` | `…/threads` | conversas de um assunto |
| `POST` | `…/threads` | abre uma conversa com o primeiro comentário |
| `GET` | `…/threads/:threadId/comments` | comentários |
| `POST` | `…/threads/:threadId/comments` | comenta |
| `GET` | `…/story-scripts` | roteiros enviados de um período |
| `POST` | `…/story-scripts/:scriptId/recorded` | marca o roteiro como gravado |

## Início

1. `GET …` traz o cadastro do cliente e o resumo do Início.
2. No primeiro acesso, mostre as boas-vindas e chame `POST …/onboarding/seen`.

## Aprovar conteúdos

1. O que espera a pessoa: `GET …/contents/awaiting-approval`.
2. O calendário de um período: `GET …/contents`.
3. Para abrir um post, use `GET …/contents/:contentId`. As mídias vêm por URL assinada de curta duração; se expirar, peça outra.
4. Para decidir, chame `approve`, ou `request-changes` com comentário.

**Regras**
- Uma pessoa basta para aprovar, e fica registrado quem aprovou.
- Aprovar leva o conteúdo a "Aprovado". Pedir ajuste leva a "em ajuste", e a agência reenvia depois de ajustar.
- Se a agência mudar a legenda, a mídia, a capa ou o formato de um conteúdo aprovado, ele volta a esperar aprovação.

**O que o portal vê de cada conteúdo**

| estado | o portal vê |
|---|---|
| em produção | só título, data e tipo |
| aguardando aprovação, em ajuste, aprovado, publicado | também a legenda e a mídia |

O portal **nunca** vê subtarefa, responsável, prazo interno nem roteiro em rascunho. A API não devolve esses dados.

## Conversas

- A pessoa abre conversas e comenta, mas não as resolve. Só a agência resolve.
- Um comentário novo reabre uma conversa resolvida.
- Num conteúdo, só dá para comentar a partir de "aguardando aprovação".
- Comentário não se edita nem se apaga.

## Estudo de marca

É só leitura. Personas arquivadas não aparecem.

## Roteiros de stories

1. `GET …/story-scripts` lista os roteiros que a agência **enviou**; rascunhos não aparecem.
2. Depois de gravar, a pessoa marca o roteiro com `POST …/story-scripts/:scriptId/recorded`.

## Agência em modo leitura

Com o teste vencido ou o plano encerrado, o portal continua visível. Aprovar, pedir ajuste e comentar recebem `409 AGENCY_READ_ONLY`.

## Interface Expo

O portal mobile apresenta feed em Geral, calendário e fila de aprovações. Revisar abre legenda, mídias e comentários apenas nos estados permitidos acima. Aprovar e pedir ajuste enviam a revisão lida. Não há seletor de clientes da agência nem kanban no portal. A agência de demonstração usa a API real com dados de exemplo; veja [interface mobile](../interface-mobile.md).


## Ampliação da integração nativa

O portal exige contexto de cliente autenticado. Boas-vindas usam o campo de primeiro acesso e gravam a ciência pela rota `onboarding/seen`. O estudo de marca é somente leitura; conversas não permitem escrita quando a agência está em modo leitura. Roteiros enviados podem ser lidos e marcados como gravados. Tipos de mídia são preservados na prévia de carrosséis mistos. Nenhuma sessão de agência é convertida em sessão de portal pelo aplicativo.


A aba Aprovações do aplicativo usa a rota própria `contents/awaiting-approval`, percorre todas as páginas e não restringe as pendências ao mês do calendário. O feed e o calendário continuam no período escolhido. A lista não inventa legenda, mídias ou revisão; ao abrir, o detalhe atual da API fornece o conteúdo e a revisão que serão usados na decisão.

## Contexto e comunicação no mobile

O cabeçalho identifica o portal do cliente, separado da área da agência. Trocar contexto usa somente vínculos existentes. Aprovar, retirar aprovação e solicitar ajuste mantêm os contratos e a revisão da API; cada resultado comunica a ação confirmada. O calendário preserva o dia selecionado ao voltar da publicação e anuncia quantidade e estados além da cor.

## Acesso ao cliente de exemplo

Na web de desenvolvimento com demonstração habilitada, cada proprietário da própria “Agência Horizonte · Demonstração” pode preparar explicitamente seu acesso ao portal da “Clínica Vida · Exemplo”. A ação usa somente o e-mail verificado da sessão e o cliente encontrado pela API dentro dessa agência; não aceita outro destinatário nem escolhe um identificador arbitrário.

O app reaproveita vínculo ativo, não reativa acesso removido automaticamente e só oferece a entrada após a API devolver o contexto de cliente correspondente. A troca usa o mesmo seletor de contexto autenticado das demais entradas. Qualquer conta verificada pode repetir o fluxo no próprio espaço de demonstração; isso não abre uma agência compartilhada nem altera as permissões do portal.
