# Confirmação do cadastro mobile na mesma interface

**Validação.** Pendente de validação do dono.

## Contexto

O cadastro do mobile web recebe o link desktop e termina em `/comecar`, apesar de compartilhar a conta e a sessão com o app. Correção solicitada pelo responsável pelo mobile em 06/11/2026, issue #845.

## Decisão

No deploy `dev`, que publica a interface Expo Web, pedidos de cadastro e reenvio identificados exatamente como `mobile-web` geram o link de confirmação na mesma origem em `/app-mobile/?action=verify&token=…`. O app usa sua confirmação existente, exige o token e a senha normalmente e carrega os acessos na própria interface. O token sai da barra ao ser capturado. Não existe destino arbitrário de retorno. Produção e pedidos sem essa indicação mantêm o link desktop.

## Consequências

O link funciona também em outro navegador, sem depender de armazenamento local. Links antigos permanecem válidos no destino original. A indicação escolhe somente a interface: não altera autorização, tabelas, sessão, validade ou consumo do token.
