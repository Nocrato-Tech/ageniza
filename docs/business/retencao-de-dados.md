# Retenção de dados

Quanto tempo o Ageniza guarda cada dado que existe só por conveniência ou por engano, e o que o apaga. É a referência para a política de privacidade: o texto jurídico não pode prometer um prazo diferente do que está aqui. Cada linha aponta para a decisão que a criou e para o job que a cumpre.

| Dado | Prazo | O que acontece | Decisão | Job |
| --- | --- | --- | --- | --- |
| Conta que ninguém confirmou (nome, e-mail, credencial, confirmações e aceites dela) | 7 dias depois de criada | A conta e tudo que só diz respeito a ela são apagados. Conta com agência, vínculo, convite ou sessão válida, e conta confirmada, nunca. | [2026-10-27](decisions/2026-10-27-estrutural-contas-nao-confirmadas-somem-em-7-dias.md) | `accounts.purge-unconfirmed`, todos os dias às 04:10 (Brasília) |
| Arquivos de mídia removida | 30 dias depois da remoção | O arquivo sai do armazenamento; a linha fica, carimbada, para a auditoria. | [2026-10-11](decisions/2026-10-11-midia-removida-sai-do-armazenamento-30-dias-depois-e-a-linha-fica.md) | `media.purge-removed`, todos os dias às 03:40 (Brasília) |

O link de confirmação de uma conta sem vínculo vence em 24 horas ou no sétimo dia da conta, o que vier primeiro: nunca depois do expurgo.

Registro de auditoria: o expurgo da conta grava o id da conta apagada e nada mais (nunca o e-mail nem o nome).

**Nome da conta assumida.** Quando o dono do e-mail assume uma conta não confirmada pela redefinição de senha, o nome que quem a criou digitou é substituído pela parte do e-mail antes do `@`, que o dono edita no perfil (mesma decisão).
