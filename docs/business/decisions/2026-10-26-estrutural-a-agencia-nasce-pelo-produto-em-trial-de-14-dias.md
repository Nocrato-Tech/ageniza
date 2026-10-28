# ESTRUTURAL: a agência nasce pelo produto, em trial de 14 dias, e o upgrade é da operação

**Data.** 2026-10-26

**Contexto.** Uma agência só nascia por comando interno (`pnpm cli:agency`, decisão 2026-09-15). A cobrança está prevista e não desenhada, e o gatilho registrado para desenhá-la é "a primeira vez que um limite precisar ser imposto por plano, e não por configuração da operação" (decisão 2026-09-24). O cadastro público (decisão do mesmo dia) dispara esse gatilho: o trial é um limite por plano.

**Decisão.** O dono decidiu:

1. **Qualquer conta com e-mail verificado cria uma agência** pelo produto. A opção "Criar agência" fica na tela de quem não tem nenhum contexto e no seletor de contexto, também para quem já é colaborador ou pessoa do portal de outra agência. Quem cria vira Owner, com o vínculo Admin, como na ativação por comando. Uma conta com o e-mail ainda não confirmado (a criada pelo aceite de um convite) não cria agência.
2. A agência nasce em **trial de 14 dias**, com no máximo **3 clientes**, **3 colaboradores** e **2 GB** de armazenamento. O Owner conta como um dos 3 colaboradores. Convites de colaborador pendentes contam, e os acessos ao portal não. Clientes arquivados não contam.
3. Ao fim dos 14 dias, a agência fica **somente leitura**: tudo continua visível na agência e no portal, nada é apagado, e a escrita é recusada. Isso inclui criar, editar, enviar para aprovação, aprovar (pelo portal e pelo link do e-mail), comentar, fazer upload, convidar e adicionar pessoa ao portal. **Continuam liberadas as ações que reduzem acesso**: remover colaborador, remover acesso ao portal, cancelar convite e os pedidos de LGPD. Continua liberado também o comando interno da operação. Os convites pendentes deixam de ser aceitáveis, como na suspensão. O topo da agência diz quantos dias faltam durante o trial e, depois, que o trial acabou e como falar com a operação.
4. **O worker na agência com trial vencido.** Param todos os e-mails da agência: "conteúdos para aprovar", "publicado", boas-vindas ao portal e convites. É o mesmo que acontece na suspensão. A retenção continua: a purga da mídia removida, o arquivamento pelo fim do contrato e o vencimento de links e convites seguem rodando, porque só reduzem dado ou acesso.
5. **O upgrade é um comando interno da operação**, porque não há cobrança no sistema. O comando tira o limite e o somente leitura (plano `ativo`) ou devolve à agência um trial novo com outra data. A nossa agência e as que já existem ficam `isenta`, como a decisão de 2026-09-24 pediu: um estado explícito, nunca a falta de plano.
6. **Os limites e o somente leitura valem no banco**, não só na API, e o armazenamento do trial usa a quota que `agency_storage_quotas` já impõe. **Cada contagem é feita contra a corrida**: a criação de cliente, de colaborador e de convite trava a linha da agência (`for update`) antes de contar, na mesma transação do insert, para que criações em paralelo não passem do limite.
7. Cada pessoa tem **no máximo uma agência em trial**, vigente ou vencida, até o upgrade, para o trial não se renovar criando agências novas. A regra vale pelo **e-mail normalizado** do Owner: minúsculas, sem o `+alias` e, no `gmail.com` e no `googlemail.com`, sem pontos e com o domínio unificado. Um índice único parcial (só nas agências em `trial`) sobre esse e-mail normalizado impede a corrida. É um risco **reduzido, não eliminado**: quem tem outros endereços, ou um domínio próprio, cria outro trial, e isso fica aceito.
8. **Limite de e-mails por agência e por dia** nos convites de colaborador (criar e reenviar) e em "Adicionar pessoa" ao portal (decisão do mesmo dia sobre o acesso ao portal). O limite é **mais baixo no trial**. Valores iniciais propostos: 20 e-mails por dia no trial e 200 nas demais agências, ajustáveis pela operação. A contagem fica no banco, sob a mesma trava do item 6. Passado o limite, a rota recusa com "Limite diário de envios atingido. Tente amanhã." e nada é gravado. Assim, a entrada aberta não vira um disparador de spam com a nossa reputação de envio.

**Consequência.** Estrutural, e altera tabelas e policies existentes:

- um estado novo de plano na agência (`trial`, `ativo`, `isenta`, com o fim do trial e o e-mail normalizado do Owner), com **backfill**: toda agência existente fica `isenta`;
- uma verificação de "agência aceita escrita" nas policies de escrita de todos os módulos, com as exceções do item 3;
- contagens impostas pelo banco, sob trava, nas criações de cliente, de colaborador, de convite e de acesso ao portal, e o índice único parcial do item 7;
- o worker passa a filtrar os e-mails pela agência que aceita escrita, além da suspensão.

`pnpm cli:agency` continua existindo. Substitui em parte a decisão de 2026-09-15 e realiza o gatilho da decisão de 2026-09-24, sem desenhar cobrança: preço, pagamento e faturamento continuam fora. Pede revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26. Os 14 dias, os 3 clientes, os 3 colaboradores, os 2 GB, o somente leitura e o upgrade por comando foram escolhidos pelo dono. O que conta no limite (item 2, segunda parte), as exceções do somente leitura (item 3), o worker (item 4) e os itens 6 a 8 foram propostos pelo maestro, alguns pela revisão do PR #720. **Substituída em parte em 2026-10-27**, quanto ao upgrade (item 5) e ao comando interno: a agência só nasce pelo produto, e a operação só troca o plano de uma agência existente, num comando único (ver a entrada de 2026-10-27 "ESTRUTURAL: a agência só nasce pelo produto, o plano `isenta` e o aviso do somente leitura"). O resto continua valendo.

**Validação.** Validada pelo dono em 2026-10-27.
