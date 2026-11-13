# Persona arquivada é somente leitura: nenhum campo muda, e a única escrita aceita é desarquivar

**Data.** 2026-11-13

**Contexto.** A tela do estudo de marca já mostra a persona arquivada só em leitura, com **Desarquivar**. A API, porém, aceitava um `PATCH` numa persona arquivada e gravava: a pessoa A abre a edição, a pessoa B arquiva, e o `PATCH` de A (ou o de qualquer cliente HTTP) altera a persona arquivada. Nenhuma decisão dizia isso de forma explícita; as de 2026-10-07 e 2026-10-08 tratam só da **conversa** da persona arquivada. A #891 pediu a regra.

**Decisão.** A persona arquivada é **somente leitura**. Nenhum campo dela muda enquanto estiver arquivada: nome, descrição, dores, desejos, objeções, idade, ocupação, local, traços, "onde está" e "tom que funciona". A única escrita aceita é a que a **desarquiva**, e essa muda só o status. Escrever de novo numa persona arquivada sem desarquivá-la, inclusive arquivar quem já está arquivada, é recusado. A recusa é `409 PERSONA_READ_ONLY`, com a mensagem "Esta persona está arquivada. Desarquive-a para editar.", e vale também para quem edita pelo banco com o papel da aplicação, não só pela rota. Desarquivar continua como era: devolve a persona à edição.

**Consequência.** O banco recusa (gatilho `BEFORE UPDATE`, código `A0137`) e a API só traduz o erro, sem uma segunda cópia da regra. Por ser `BEFORE`, o `PATCH` que esperava o arquivamento ainda não confirmado é recusado depois dele, e a persona fica como o arquivamento a deixou. Não muda coluna, policy nem grant, e não há backfill: personas arquivadas antes continuam como estão e deixam de aceitar edição. Os papéis que a RLS não restringe (migrations e operação) não são barrados.

**Origem.** Issue #891, achada na revisão da onda 6 da #890; `specs/clientes.md`, seções 4 e 5; decisões `2026-10-07-conversa-persona-arquivada-recusa-abrir-thread` e `2026-10-08-conversa-de-persona-arquivada-sem-caminho-na-tela`.

**Validação.** Pendente de validação do dono.
