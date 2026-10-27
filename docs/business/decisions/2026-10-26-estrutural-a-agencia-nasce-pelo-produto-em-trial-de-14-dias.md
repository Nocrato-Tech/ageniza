# ESTRUTURAL: a agência nasce pelo produto, em trial de 14 dias, e o upgrade é da operação

**Data.** 2026-10-26

**Contexto.** Uma agência só nascia por comando interno (`pnpm cli:agency`, decisão 2026-09-15). A cobrança está prevista e não desenhada, e o gatilho registrado para desenhá-la é "a primeira vez que um limite precisar ser imposto por plano, e não por configuração da operação" (decisão 2026-09-24). O cadastro público (decisão do mesmo dia) dispara esse gatilho: o trial é um limite por plano.

**Decisão.** O dono decidiu:

1. **Qualquer conta com e-mail verificado cria uma agência** pelo produto. A opção "Criar agência" fica na tela de quem não tem nenhum contexto e no seletor de contexto, também para quem já é colaborador ou pessoa do portal de outra agência. Quem cria vira Owner, com o vínculo Admin, como na ativação por comando.
2. A agência nasce em **trial de 14 dias**, com no máximo **3 clientes**, **3 colaboradores** e **2 GB** de armazenamento. O Owner conta como um dos 3 colaboradores. Convites de colaborador pendentes contam, e convites de portal não. Clientes arquivados não contam.
3. Ao fim dos 14 dias, a agência fica **somente leitura**: tudo continua visível na agência e no portal, nada é apagado, e toda escrita é recusada. Isso inclui criar, editar, enviar para aprovação, aprovar, comentar, fazer upload e convidar. Os e-mails ao cliente param e os convites pendentes deixam de ser aceitáveis, como na suspensão. O topo da agência diz quantos dias faltam durante o trial e, depois, que o trial acabou e como falar com a operação.
4. **O upgrade é um comando interno da operação**, porque não há cobrança no sistema. O comando tira o limite e o somente leitura (plano `ativo`) ou devolve à agência um trial novo com outra data. A nossa agência e as que já existem ficam `isenta`, como a decisão de 2026-09-24 pediu: um estado explícito, nunca a falta de plano.
5. **Os limites e o somente leitura valem no banco**, não só na API, e o armazenamento do trial usa a quota que `agency_storage_quotas` já impõe.
6. Cada conta tem **no máximo uma agência em trial** ao mesmo tempo, para o trial não se renovar criando agências novas.

**Consequência.** Estrutural: um estado novo de plano na agência (`trial`, `ativo`, `isenta`, com o fim do trial), um backfill (toda agência existente fica `isenta`), uma verificação de "agência aceita escrita" nas policies de escrita de todos os módulos, e contagens impostas pelo banco nas criações de cliente, de colaborador e de convite. `pnpm cli:agency` continua existindo. Substitui a decisão de 2026-09-15 e realiza o gatilho da decisão de 2026-09-24, sem desenhar cobrança: preço, pagamento e faturamento continuam fora. Pede revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26. Os itens 1 a 4 (14 dias, 3 clientes, 3 colaboradores, 2 GB, somente leitura e upgrade por comando) foram escolhidos pelo dono. O que conta no limite (item 2, segunda parte), o item 5 e o item 6 foram propostos pelo maestro e estão **pendentes de validação pelo dono do produto**.
