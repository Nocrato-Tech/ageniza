# O acesso ao portal no somente leitura e no limite diário de e-mails

**Data.** 2026-10-27

**Contexto.** O #725 (trial) entrou: agência com trial vencido fica somente leitura (A0090), com as ações que reduzem acesso liberadas, e cada agência tem um limite diário de e-mails (A0095, 429). O gatilho do limite olha só a tabela `invitations`; "Adicionar pessoa" não cria convite, então o e-mail de boas-vindas ficaria fora da conta.

**Decisão.**

1. Adicionar pessoa e Reativar **ampliam** acesso: agência em somente leitura recusa os dois (A0090, 409). **Remover** acesso **reduz** e continua livre, como remover colaborador e cancelar convite. A tabela `client_portal_accesses` ganha o gatilho de somente leitura com essa exceção, reconhecida pela mudança exata da linha (ativo para removido, geração mais um, nada mais).
2. O e-mail de boas-vindas conta no limite diário **no mesmo orçamento e sob a mesma trava** dos convites: um endereço novo e um endereço removido que volta a ser adicionado gastam um lugar cada, e passado o limite a rota responde 429 sem gravar nada. Adicionar um endereço que já tem acesso ativo não manda e-mail e não gasta. O gatilho dos convites passa a contar também esses e-mails. A contagem lê os eventos de auditoria `client_member.added` e `client_member.readded`.
3. O vínculo no login ignora o acesso de agência em somente leitura; o aceite do convite antigo, que grava sem ator de agência, recusa com A0090.

**Consequência.** Substitui o `TODO(#725)` da implementação. O código de erro do endereço que não é e-mail muda para A0098, porque A0095 é o limite diário.

**Origem.** Pedido do maestro, na revisão do PR #728.

**Validação.** Validada pelo dono em 2026-10-27.
