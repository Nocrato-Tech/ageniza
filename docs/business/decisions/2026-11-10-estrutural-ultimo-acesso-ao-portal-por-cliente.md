# ESTRUTURAL: o acesso ao portal guarda o último acesso, e a agência o vê na lista de pessoas

**Data.** 2026-11-10

**Contexto.** A agência não sabe se a pessoa do cliente chegou a entrar no portal. O banco guarda só a primeira entrada, e ela não diz se a pessoa voltou.

**Decisão.**

1. **O que se guarda.** Cada acesso de pessoa do portal guarda a **data e hora da última entrada naquele cliente**.
2. **Quando se grava.** Ao entrar no contexto do cliente e ao usar o link de aprovação.
3. **Somente leitura.** Com a agência em somente leitura, nada é gravado.
4. **O que a agência vê.** Na lista de pessoas do portal, "último acesso" ou "nunca entrou". Vê a informação quem já pode ver essa lista.

**Consequência.**

- É estrutural porque **altera uma tabela que já existe** (o acesso da pessoa do portal ao cliente ganha uma coluna) e muda a função que marca a entrada.
- A lista de pessoas do portal passa a trazer o último acesso, sem permissão nova.
- "Nunca entrou" não exige dado novo: já se sabe pela primeira entrada.
- Pede revisão de segurança independente, por tocar o banco e o portal.

**Origem.** Pedido do dono do produto em 2026-11-10, depois da pesquisa da Orkestrya e do Refcat (2026-11-09).

**Validação.** Pendente de validação do dono.
