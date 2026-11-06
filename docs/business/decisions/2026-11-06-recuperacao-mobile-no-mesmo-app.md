# Recuperação de senha no mobile web

**Validação.** Pendente de validação do dono.

## Contexto

O usuário concluiu a redefinição real, mas recebeu o destino desktop ao pedir recuperação no mobile (#847).

## Decisão

No deploy dev, pedidos de recuperação identificados exatamente como mobile-web geram um destino fixo da mesma origem em `/app-mobile/?action=reset&token=…`. O mobile usa a redefinição existente e retorna ao seu login após a revogação das sessões. Não aceita destino arbitrário. Produção, pedidos desktop e recuperação com continuação de convite mantêm o fluxo desktop existente.

## Consequências

O contexto é por requisição, inclusive durante callbacks assíncronos do Better Auth. Não altera senha, sessão, autorização ou validade dos tokens. Links antigos mantêm o destino original.
