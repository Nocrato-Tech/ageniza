# O vínculo no login pega um acesso por cliente, e só de cliente ativo em agência ativa

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 diz que, quando uma conta com o e-mail verificado entra, cada acesso ativo daquele e-mail e ainda sem conta passa a ser dela. A tabela tem um acesso por `(cliente, conta)`, então o vínculo precisa dizer o que fazer quando a conta já tem outra linha no mesmo cliente, e o que fazer com cliente arquivado ou agência suspensa.

**Decisão.**

1. O vínculo roda na resolução de contextos (`/me/contexts`, `resolve` e o login), com a conta da transação. A função não recebe a conta como argumento. O vínculo **não** faz a pessoa "entrar": a lista da agência só mostra "entrou" e o nome depois da primeira entrada no portal daquele cliente (`2026-10-27-a-lista-de-acessos-so-mostra-quem-entrou-no-portal-daquele-cliente`).
2. Se a conta já tem **outra linha ativa** no mesmo cliente, ela já está no portal: o acesso novo continua sem conta. Se tem uma linha **removida**, essa linha é história e solta a conta, e o mesmo membership passa para a linha nova.
3. O vínculo não pega acesso de **cliente arquivado**, de **agência suspensa** nem de agência em **somente leitura** (trial vencido): nada se escreve nesses clientes, e a carga dos contextos não falha por causa disso. O acesso espera, e a conta o leva no primeiro login depois que o cliente ou a agência voltar.
4. O e-mail comparado é o da conta em minúsculas e sem espaços, igual ao do acesso; `+alias` não se tira.

**Consequência.** Não muda tabela. O aceite do convite antigo, que também grava sem ator de agência, confere o mesmo (`A0090`).

**Origem.** Decisão de 2026-10-26, item 3, e a lição da revisão de segurança do #725 sobre escrita sem ator conferir o estado da agência. Os itens 2 e 3 são da implementação (issue #711).

**Validação.** Pendente de validação do dono.
