# Portal — Marca: a conversa concluída é dita ao cliente sem o nome de quem a concluiu

**Data.** 2026-10-08

**Contexto.** A SPEC (`specs/clientes.md`, seção 7) diz só que a tela do portal "mostra que a agência a concluiu" e não diz se o cliente vê quem concluiu. A API já serve o nome: `resolvedBy.name` vem do vínculo de agência e a rota do portal o devolve também ao cliente (`conversations.integration.test.ts`, "names who resolved a thread … on both sides"). A decisão `2026-10-07-conversa-resolucao-so-aparece-enquanto-resolvida` trata de quando a resolução aparece e de onde vem o nome, não de escondê-lo do cliente.

**Decisão.** Na Marca do portal, a conversa concluída é dita como "A agência concluiu esta conversa em dd/mm" e, na lista, "concluída", sem o nome de quem a concluiu. É escolha desta tela, por linguagem de cliente: o cliente fala com a agência, não com uma pessoa dela, e "concluiu" sem nome evita expor ao cliente um nome interno que ele não precisa para agir. O dado continua na resposta da API; a tela só não o mostra.

**Consequência.** Se o produto preferir mostrar o nome, é mudança só de texto da tela, sem API nem migration, já que a API serve o nome ao portal. A aba da agência continua mostrando "Resolvida por …".

**Origem.** Issue #143; `specs/clientes.md`, seção 7; revisão do PR #420.

**Validação.** Pendente de validação do dono.
