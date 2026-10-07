# Proteções de integridade do quadro, e a que não deve existir

**Data.** 2026-09-24

**Contexto.** O material do Notion listava quatro proteções para a tela de colaboradores. Uma delas custa caro e protege algo que já está garantido.

**Decisão.** Três valem:

1. **O Owner não é removido nem tem o papel alterado por esta tela.** Transferência de posse é fluxo próprio, e não existe hoje.
2. **Ninguém altera o próprio papel**, nem o Admin.
3. **Ninguém remove a si mesmo.**

E a quarta é **descartada**: "a agência nunca fica sem administração válida". O Owner tem acesso total por posse, não por papel, e não pode ser removido por esta tela — então a agência nunca fica sem administração, aconteça o que acontecer com os Admins. Implementar "não pode remover o último Admin" custaria uma contagem sob concorrência para proteger algo que a posse já garante, e contagem sob concorrência é exatamente a classe de defeito da #59.

**Consequência.** Quem remover o último Admin deixa a agência administrável apenas pelo Owner, o que é um estado legítimo e não um defeito.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

