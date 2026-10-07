# A agência pode abrir conversa numa seção ainda não preenchida; o portal, não

**Data.** 2026-10-07

**Contexto.** A issue #130 manda recusar com 409 a conversa nova do portal numa seção que a agência não preencheu ("Sua agência está preparando esta parte", sem **Sugerir**). A #128 e a SPEC não dizem nada sobre a agência abrir conversa numa seção vazia.

**Decisão.** A regra vale **só para o portal**. A agência abre conversa em qualquer das sete seções, preenchidas ou não, porque é ela quem preenche a seção, e a aba do estudo mostra **+ conversa** em toda seção. "Preenchida" é a definição única do estudo: texto não vazio depois de aparado, ao menos uma cor, um arquétipo, e `personas` quando há ao menos uma persona ativa.

**Consequência.** Se o produto quiser impedir também a conversa da agência numa seção vazia, é uma condição a mais na mesma função do serviço, sem migration.

**Origem.** Issues #128 e #130; `specs/clientes.md`, seções 4 e 7.

**Validação.** Pendente de validação do dono.
