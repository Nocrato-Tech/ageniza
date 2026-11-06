# O portal não expõe a cobrança da agência ao cliente final

**Data.** 2026-11-06

**Validação.** Pendente de validação do dono.

## Contexto

Quando o plano da agência acaba (teste vencido ou assinatura cancelada que chegou ao fim), o portal fica somente leitura e o aviso dizia ao cliente final que "o plano de {agência} precisa ser renovado". Isso conta ao cliente da agência um assunto financeiro que é só da agência.

## Decisão

O aviso do portal somente leitura não menciona plano, renovação, assinatura nem cobrança. Diz que a aprovação está pausada no momento, que a equipe da agência já foi avisada e que tudo continua visível. A cobrança e o caminho para assinar aparecem apenas para o Owner, na área da agência.

Vale para **toda** superfície do portal, não só para o aviso do topo: o motivo que aparece ao passar o mouse ou focar nos botões bloqueados (Aprovar, Pedir ajuste, conversas do estudo de marca e do conteúdo, Já gravei) e a mensagem de uma recusa quando a agência fica somente leitura no meio do uso. Todos dizem "A aprovação está pausada no momento. A agência já foi avisada.", e o texto que a API manda sobre o plano nunca é mostrado ao cliente.

Esta decisão **substitui o item 5 da decisão `2026-10-27-estrutural-a-agencia-so-nasce-pelo-produto-e-o-plano-isenta`** (o motivo "O plano precisa ser renovado para usar esta opção") no que diz respeito ao portal; na área da agência esse motivo continua valendo.

## Consequência

O cliente final não aprende nada sobre a situação financeira da agência e sabe o que fazer: esperar. O texto antigo deixa de existir. Os limites e a escrita bloqueada não mudam; só a mensagem.

## Origem

Pedido do maestro do épico #770 ao implementar a #773 (aviso de pré-fim e portal neutro).
