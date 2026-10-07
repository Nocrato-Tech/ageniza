# Quem resolveu e quando só aparece enquanto a conversa está resolvida

**Data.** 2026-10-07

**Contexto.** O estado da thread é derivado: resolvida só enquanto `resolved_at` é posterior ao último comentário. Um comentário da agência numa thread resolvida a reabre sem ninguém escrever na thread, então a linha continua com `resolved_at` e `resolved_by` antigos (só o comentário do cliente os limpa, pelo gatilho do #212). Mostrar "resolvida por fulana em tal dia" numa thread que já voltou a ser aberta descreve um estado que não existe mais. A SPEC não diz o que a listagem devolve nesse caso, nem o que mostrar de quem resolveu quando essa pessoa nunca comentou na thread.

**Decisão.** `resolvedBy` e `resolvedAt` vêm preenchidos **somente** quando `state` é `resolved`; numa thread aberta são `null`, mesmo que a linha ainda guarde os carimbos. `resolvedBy.name` vem do mesmo caminho de leitura de autor e é `null` quando quem resolveu nunca comentou na thread: o nome nunca é buscado fora do vínculo do comentário. Resolver uma thread que já está resolvida não escreve nada, e mantém o primeiro responsável e o primeiro momento.

**Consequência.** A tela da agência pode precisar de um texto neutro ("resolvida pela agência") quando o nome vier `null`. Se o produto quiser sempre o nome de quem resolveu, a função de leitura de autor passa a incluir também `resolved_by`, o que é uma migration nova.

**Origem.** Issue #128; `specs/clientes.md`, seção 4.

**Validação.** Pendente de validação do dono.
