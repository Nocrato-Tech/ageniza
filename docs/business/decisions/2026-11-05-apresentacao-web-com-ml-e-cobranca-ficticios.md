# Apresentação web com ML e cobrança fictícios

**Validação.** Pendente de validação do dono.

## Contexto e autorização

O usuário responsável pelo UX autorizou expressamente nesta conversa: dados fictícios para ML, notificações somente na web para apresentar à professora, cobrança fictícia e acesso iOS somente pelo navegador. Essa autorização substitui, para a apresentação acadêmica, a exigência anterior de dados exclusivamente reais nesses recursos. Não autoriza apresentar uma simulação como lançamento de produção.

## Decisão para esta entrega

Uma entrada web de apresentação, habilitada explicitamente no build, oferece ML com treino e avaliação sobre amostras sintéticas identificadas, avisos no navegador acionados pela pessoa e contratação/cancelamento simulados. A apresentação não consulta nem escreve na API e não recebe credenciais ou dados de cartão. A entrada autenticada existente permanece usando dados reais. Android/iOS assinados, cobrança financeira real e envio remoto de push não fazem parte desta apresentação.

## Consequências

Amostras, métricas e recibos são demonstrativos. Notificação depende do suporte e permissão do navegador; recusa e ausência de suporte aparecem na tela. O envio é local e solicitado pelo botão, sem promessa de push remoto com a aplicação fechada. A disponibilidade fictícia é isolada da assinatura e das permissões reais. A SPEC está em `specs/apresentacao-web.md`. Não há alteração de tabelas, contratos, RLS ou autorização.
