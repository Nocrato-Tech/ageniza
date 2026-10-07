# Falha ao enfileirar não derruba a confirmação do upload
**Data.** 2026-09-18

**Contexto.** Se a fila estiver indisponível no instante da confirmação, ou o upload se perde, ou o processamento se perde.

**Decisão.** A confirmação é concluída e a falha ao enfileirar é apenas registrada.

**Consequência.** O arquivo fica `pending` sem ninguém para processá-lo, e não existe varredura que recupere esses casos.

**Origem.** PR #40. **Pendente de validação.**

