# O fim do teste é aplicado pelo backend, e os avisos só avisam

**Data.** 2026-10-13

**Contexto.** O teste dura 14 dias, com avisos por e-mail e banner. Se a mudança de estado dependesse do aviso ou de alguém entrar no sistema, um e-mail que falha deixaria a agência no teste para sempre.

**Decisão.** Toda transição com prazo (fim do teste, fim da carência, fim do período cancelado, exclusão em 90 dias) é aplicada pelo backend a partir da data registrada na agência, sem depender de aviso nem de acesso. Os avisos ao Owner durante o teste saem no 7º, no 12º e no 14º dia, por e-mail, e um banner fixo mostra os dias restantes e "Escolher plano" a partir do 7º dia. O aviso do 14º dia diz o que acontece no fim do teste e leva direto à contratação. Os envios são idempotentes, param quando a agência paga, e contam os dias no dia de São Paulo, como o resto do produto (fuso por agência é o em aberto #153).

**Consequência.** É trabalho agendado sem requisição, e segue a forma estrutural já decidida: função `security definer` de escopo único, auditada, chamada pelo job.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
