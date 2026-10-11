# Portal — Marca: a conversa concluída é dita ao cliente com o nome de quem a concluiu

**Data.** 2026-10-08

**Contexto.** A SPEC (`specs/clientes.md`, seção 7) diz só que a tela do portal "mostra que a agência a concluiu" e não diz se o cliente vê quem concluiu. A API já serve o nome: `resolvedBy.name` vem do vínculo de agência e a rota do portal o devolve também ao cliente (`conversations.integration.test.ts`, "names who resolved a thread … on both sides"). A decisão `2026-10-07-conversa-resolucao-so-aparece-enquanto-resolvida` trata de quando a resolução aparece e de onde vem o nome, não de esconder ou mostrar o nome ao cliente.

**Decisão.** Na Marca do portal, a conversa concluída é dita como "Concluída por <nome> em dd/mm", com o nome de `resolvedBy.name`, como a API entrega. Quando o nome é nulo (o vínculo de quem concluiu não tem nome para ler), a tela diz "A agência concluiu esta conversa em dd/mm", sem inventar nome e sem imprimir "null". Na lista, a linha da conversa continua dizendo "concluída".

**Consequência.** É texto de tela: sem API, sem migration. A aba da agência continua mostrando "Resolvida por …". O cliente passa a ver o nome de uma pessoa da agência que concluiu a conversa, o mesmo nome que a API já devolvia à tela do portal.

**Origem.** Issue #143; `specs/clientes.md`, seção 7; revisão do PR #420. Decisão do dono em 2026-10-08, que trocou a escolha inicial desta tela (dizer só "a agência concluiu", sem nome).

**Validação.** Validada pelo dono em 2026-10-08.
