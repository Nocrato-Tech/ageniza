# Indicadores de conteúdo da carteira: o que é pendente, em revisão e atrasado, e a ordem por atraso

**Data.** 2026-10-11

**Contexto.** A SPEC de Clientes reservou no card a faixa "pendentes · em revisão · atrasos" e a SPEC de Conteúdo (`specs/conteudo.md` §2, §4 e §7) a preenche: o atraso é o primeiro critério da carteira para quem lê Conteúdo, e Vendas e Financeiro não recebem os indicadores nem mudam de ordem. A SPEC define "atrasado" (data planejada passada, sem publicado nem cancelado), mas não diz que estado compõe "pendente" nem "em revisão", nem como o atraso entra na ordem. A issue #261 pede os três números e a ordem.

**Decisão.**
1. **Pendente** é o trabalho que ainda é da agência: conteúdo em produção ou em ajuste. **Em revisão** é o que espera o cliente: aguardando aprovação. **Aprovado** (pronto para publicar) não é pendente nem em revisão, e só aparece nos números se estiver atrasado. Publicado e cancelado nunca contam.
2. **Atrasado** é o conteúdo em produção, aguardando aprovação, em ajuste ou aprovado cuja data planejada é anterior ao dia de hoje em São Paulo, lido de `app_private.sao_paulo_date`. O dia de hoje é "não atrasado"; o dia anterior é atrasado, e a virada acontece à meia-noite de São Paulo (03:00Z), não de UTC. O atraso se sobrepõe aos outros dois números: um conteúdo em produção e atrasado conta em pendente e em atrasado.
3. **A resposta da carteira** traz `contentIndicators: { pending, inReview, overdue }` por cliente. Para quem não tem `conteudo.visualizar` (Vendas, Financeiro e qualquer papel sem a permissão) o campo **não existe**, como `pendingInvitations`: zero seria um número que a tela mostraria. O Owner o recebe por posse.
4. **Ordem.** Na ordem `attention`, quem tem ao menos um conteúdo atrasado vem **antes de todos**; depois, quem tem sugestão aguardando a agência; depois o nome ascendente, com `id` de desempate. É um critério booleano ("tem atraso"), como o das sugestões, e não a quantidade. Para quem não lê Conteúdo, a ordem é a de antes. A ordem `name:asc` não muda para ninguém.
5. **O cliente arquivado** recebe os números e a ordem como os demais (filtro `status=archived` inclusive): o atraso de um conteúdo que ficou aberto antes do encerramento é informação, e a SPEC só pede a tela esmaecida e sem selos, que é decisão da tela.

**Consequência.**
- A regra mora no SQL de `apps/api/src/modules/clients/service.ts` (uma CTE agrupada por cliente e filtrada pela agência, como a dos convites pendentes). O módulo `contents` ainda não expõe a regra de atraso; quando expuser, a definição deve ser unificada.
- A tela (#134 e a de Conteúdo) mostra a faixa só quando o campo existe.
- Dois estados que a SPEC pode vir a querer separar (aprovado a publicar em breve, em ajuste visto separado de em produção) ficam fora até a SPEC pedir.

**Origem.** Issue #261, decidido na implementação a pedido do maestro, dentro da SPEC `specs/conteudo.md` §2, §4 e §7.

**Validação.** Pendente de validação do dono.
