# A lista de colaboradores ordena sem distinguir acento nem maiúsculas

**Data.** 2026-10-07

**Contexto.** A SPEC de colaboradores (§6) e o aceite da #89 pedem a lista "ordenada por nome ascendente", alfabética. A consulta ordena pelo nome sem fixar a ordenação, ou seja, pela do banco de cada ambiente, e o único teste de ordem usa nomes ASCII capitalizados. Em português o caso comum tem acento e caixa mista: com a ordenação por código de caractere, `Zelia` vem antes de `ana` e `Álvaro` vem depois de `bruno`. Achado da auditoria de fechamento do módulo, issue #355.

**Decisão.** A ordem da lista é alfabética **sem distinguir acento nem maiúsculas**: `Álvaro`, `ana`, `bruno`, `Éder`, `Zelia`. É regra do produto, garantida pela consulta e provada por teste com nomes acentuados e de caixa mista, em vez de depender do que cada banco entrega. O mecanismo (por exemplo, uma ordenação ICU em pt-BR) é escolha da implementação da #355.

**Consequência.** A SPEC (§6 e §7) passa a dizer isto. Nenhuma rota, tabela, policy, permissão ou formato de resposta muda; o contrato de paginação é o mesmo. O aceite da #355 (teste que afirma a ordem e mutação que a desfaz ficando vermelha) fica de pé.

**Origem.** Issue #355, decisão do maestro em 2026-10-07. **Pendente de validação** pelo dono do produto.

