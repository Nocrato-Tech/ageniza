# Apresentação acadêmica web

O usuário autorizou dados fictícios para ML e cobrança, notificações apenas no navegador e acesso iOS pela web. A SPEC está em [apresentação web](../../../specs/apresentacao-web.md).

## Acesso

Build com `EXPO_PUBLIC_PRESENTATION_FEATURES=true`, caminho `/apresentacao/`. A entrada normal e nativa continua no app autenticado. A apresentação não precisa de conta e não consulta/escreve a API. Recarregar reinicia os cenários fictícios.

## ML

1. Abrir a aba Machine learning.
2. Alterar dias restantes, tarefas pendentes e revisões, ou escolher um cenário de exemplo.
3. Conferir a classificação e os cinco vizinhos utilizados.
4. Apresentar a métrica calculada no teste separado: 72 exemplos de treino e 24 de teste, todos sintéticos e identificados. O resultado não mede desempenho real da agência.

## Avisos web

1. Abrir Avisos web e clicar em Enviar notificação de teste.
2. A pessoa decide a permissão no navegador.
3. O envio usa o service worker exclusivo da apresentação, sem interceptar requisições. Recusa, indisponibilidade ou falha não aparecem como envio bem-sucedido.
4. Clicar na notificação retorna à apresentação. É envio local solicitado pela pessoa, não push remoto com a aplicação fechada.

## Planos

1. Escolher um plano fictício e conferir o valor.
2. Simular pagamento aprovado ou recusado. Não existe campo de cartão.
3. A aprovação gera recibo demonstrativo e ativa o plano fictício; recusa mantém o estado anterior.
4. Cancelar exige confirmação, mantém o plano até o fim do ciclo demonstrativo e permite reativação. Nenhuma assinatura real é consultada ou alterada.

## Publicação

A apresentação pode ser publicada isoladamente na Vercel, preservando o encaminhamento da raiz para o app real e o download Android existente. O service worker `/presentation-notifications.js` deve ser servido como JavaScript, fora do fallback HTML. Notificações exigem suporte do navegador e contexto seguro; o teste mais previsível para a apresentação é no navegador do computador.
