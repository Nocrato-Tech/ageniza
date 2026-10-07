# Persona arquivada: a agência lê, e abrir, comentar e resolver nela é 409; o portal não a enxerga

**Data.** 2026-10-07

**Contexto.** A SPEC diz que a persona arquivada some do portal e que as threads dela "ficam somente leitura". A #128 cita só "comentar → 409", e a #130 manda tratar a persona arquivada como inexistente no portal (404). Não dizem o que acontece com **abrir** thread nova e com **resolver** na persona arquivada pelo lado da agência.

**Decisão.** Pelo lado da agência, ler a persona arquivada e as threads dela continua valendo, e **abrir, comentar e resolver** nela são recusados com `409 PERSONA_ARCHIVED`, como o banco já faz (a policy de `INSERT` e a de resolução exigem persona ativa). Pelo portal, persona arquivada e as threads dela são `404`, para listar, abrir, ler e comentar, porque a RLS já esconde a persona. Persona de outro cliente é `404` nos dois lados.

**Consequência.** O 409 sai de uma checagem **antes** da escrita, e não só do erro do banco; a corrida (persona arquivada entre a checagem e a escrita) é relida numa transação nova e dá o mesmo 409.

**Origem.** Issues #128 e #130; `specs/clientes.md`, seções 4 e 5.

**Validação.** Pendente de validação do dono.
