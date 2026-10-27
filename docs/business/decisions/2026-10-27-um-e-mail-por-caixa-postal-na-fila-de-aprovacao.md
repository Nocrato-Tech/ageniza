# Um e-mail por caixa postal na fila de aprovação

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 põe a janela de 15 minutos e o agrupamento da fila por **acesso**. Uma conta que trocou de e-mail para o endereço de outro acesso do mesmo cliente (e que o vínculo não pega, porque ela já tem linha ativa ali) fazia dois acessos resolverem para a mesma caixa, e a caixa recebia dois e-mails iguais (achado 3 do PR #728). Recusar o Adicionar revelaria que a conta existe.

**Decisão.** O destinatário continua sendo o acesso (um item por acesso e conteúdo), mas o **grupo do claim** e a janela passam a ser o **endereço final** (o da conta vinculada ou, sem conta, o do acesso), por cliente e tipo. O worker junta no mesmo e-mail os itens do mesmo endereço e lista o mesmo conteúdo uma vez; os dois itens são marcados como enviados.

**Consequência.** Nova função `app_private.notification_address`; `claim_notification_batch` e `notification_group_ready` agrupam por endereço. Com o link de aprovação (#712), o e-mail único leva um link só; os dois acessos continuam sendo atores distintos.

**Origem.** Revisão de segurança do PR #728 (achado 3, Baixa).

**Validação.** Pendente de validação do dono.
