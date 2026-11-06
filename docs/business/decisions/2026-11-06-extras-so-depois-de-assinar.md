# Extras só depois de assinar um plano

**Validação.** Validada pelo dono em 2026-11-06.

## Contexto

Ao testar a tela de assinatura (#773), o dono achou a escolha de plano confusa: ela oferecia clientes extras e armazenamento extra a quem ainda não tinha plano. Nas palavras dele, os extras "deveriam aparecer somente após a assinatura do plano, não faz sentido ter isso agora".

## Decisão

Extras (clientes e armazenamento) só existem para quem já tem um plano pago. Quem está no teste ou com o teste acabado vê apenas a tabela de planos e assina um plano puro, sem extras. Os extras, a troca de plano e o cancelamento aparecem só na tela "Seu plano", depois da primeira assinatura.

## Consequências

A primeira cobrança nunca leva extras. O plano muda para quem já assina: a tela "Seu plano" mostra o uso, os extras com o total ao vivo, a troca de plano e o cancelamento. A regra vale na tela (web e, no mesmo fluxo, no app); a API continua aceitando extras numa primeira cobrança e não foi alterada.
