# ESTRUTURAL: o nome que a agência digita ao adicionar uma pessoa do portal aparece antes de ela entrar

**Data.** 2026-11-11

**Contexto.** Na aba Acessos, quem ainda não entrou aparece só pelo e-mail, e a mensagem de WhatsApp diz "Olá!" porque não há nome. O nome da conta foi escondido de propósito até a pessoa entrar: a decisão [`2026-10-27-a-lista-de-acessos-so-mostra-quem-entrou-no-portal-daquele-cliente`](2026-10-27-a-lista-de-acessos-so-mostra-quem-entrou-no-portal-daquele-cliente.md) mostrou que uma agência que adiciona o e-mail de um usuário de outra agência passava a ver o **nome da conta dele**, o que serve de oráculo. O quadro do redesenho (r0) mostra "Olá, Débora!" na mensagem pronta antes da entrada.

**Decisão.**

1. **O nome é o que a agência digitou, não o da conta.** O modal "Adicionar pessoa" ganha o campo **Nome** (opcional, com o mesmo limite do nome do perfil). Esse nome fica no **acesso** e é o que a lista e a mensagem mostram **enquanto a pessoa não entrou**. Ele vem só do que a agência escreveu: nunca é lido da conta que tenha aquele e-mail.
2. **Depois da entrada, vale o nome da conta**, como na decisão de 2026-10-27. O nome digitado deixa de ser mostrado e de ordenar a lista.
3. **A ordem da lista** usa a mesma expressão do nome mostrado (o digitado antes da entrada, o da conta depois), para a ordem também não servir de oráculo. Sem nome digitado, a linha mostra o e-mail, como hoje.
4. **A mensagem pronta** passa a dizer "Olá, <primeiro nome>!" quando há nome (digitado antes da entrada, da conta depois) e continua em "Olá!" sem nome. Adicionar de novo um e-mail removido pode atualizar o nome.
5. **Nunca se diz se o e-mail tem conta.** Esta decisão não muda a regra de 2026-10-26 e 2026-10-27: a lista e a resposta de "Adicionar" são iguais para e-mail com e sem conta.

**Substitui.** Em [`2026-10-27-a-lista-de-acessos-so-mostra-quem-entrou-no-portal-daquele-cliente`](2026-10-27-a-lista-de-acessos-so-mostra-quem-entrou-no-portal-daquele-cliente.md), o item 2 no trecho "Antes, `entered` é falso, o nome é nulo e a linha traz o e-mail": antes da entrada o nome é o digitado pela agência, quando houver. Nada mais da decisão muda (o `entered`, a ordem, a contagem de acessos ativos, o backfill).

**Consequência.**

- **É estrutural:** altera uma tabela que já existe (`client_portal_accesses` ganha o nome digitado, anulável), muda o formato da lista de Acessos e da mensagem, e reabre uma regra anti-oráculo decidida com revisão de segurança. **Migration** nova, grant por coluna, **sem backfill** (acessos existentes ficam sem nome digitado).
- **Risco: Alto** (portal, dado pessoal e oráculo). Pede revisão de segurança independente com o mesmo ataque que achou o problema de 2026-10-27: adicionar o e-mail de uma conta de outra agência **não** mostra o nome da conta, nem muda a ordem, nem a contagem; e o nome digitado não vaza para o portal nem para outro cliente.
- O fluxo mobile da agência descreve o campo e a mensagem.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro de que só o nome digitado pela agência aparece (risco 14 do inventário).

**Validação.** Pendente de validação do dono.
