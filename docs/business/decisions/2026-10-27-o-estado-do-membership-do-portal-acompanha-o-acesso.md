# ESTRUTURAL: o estado do membership do portal acompanha o acesso, e a tabela de acessos só se escreve por função

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 sobre o acesso ao portal por e-mail pede que `client_memberships` mude "só pelas funções do acesso" e que "um trigger recuse mudar o estado fora dessas funções". Um marcador posto na transação (um `set_config` local) não prova nada: quem pode executar SQL na sessão o põe. A implementação (issue #711) precisava de uma regra que nenhum chamador consiga forjar.

**Decisão.**

1. O trigger olha o **estado** das duas tabelas, nunca um marcador. Um membership **ativo** só existe enquanto o acesso a que ele aponta está ativo e é da mesma conta. Um membership **removido** só existe com o acesso removido ou com o acesso já passado a outra conta (ou a nenhuma). Mudar o estado do membership sozinho, para um lado ou para o outro, é recusado (`42501`). O outro lado é conferido no fim da transação: um acesso ativo com conta sem o membership ativo dessa conta, ou um acesso removido (ou sem conta) com membership ativo, também é recusado. As funções do acesso escrevem as duas linhas na mesma transação.
2. `client_memberships` ganha `portal_access_id`, obrigatório. Um `INSERT` que não diz o acesso (o escritor antigo: um fixture, uma restauração) recebe o acesso da conta, criado se não existir. **Nunca nasce um membership sem acesso.**
3. `client_portal_accesses` não tem `INSERT`, `UPDATE` nem `DELETE` para a aplicação. A leitura (política de `SELECT`) é de quem tem `cliente.convidar_usuario` **e de quem tem `cliente.remover_usuario`**, porque quem remove ou reativa precisa ler o acesso que muda; a rota de listagem continua exigindo só a primeira.
4. `notification_queue.recipient_user_id` deixa de existir: o destinatário do portal é sempre `recipient_portal_access_id`, e a conta, quando há, vem do acesso. As FKs de autoria (`contents`, `client_thread_comments`, `notification_queue`) apontam para `(acesso, cliente)`, para uma autoria nunca sair do cliente do acesso.
5. A FK de `client_portal_accesses` para `clients` apaga em cascata e a de `user_id` para `auth."user"` zera. A aplicação não apaga nada; o efeito é só para a retenção e para a limpeza do banco de testes.

**Consequência.** Estrutural: altera `client_memberships`, `contents`, `client_thread_comments` e `notification_queue`, recria as funções da fila e do aceite de convite, e faz backfill. A trava por estado impede o erro que um marcador deixaria: um acesso removido com o membership ainda ativo manteria o portal aberto para a pessoa removida. Os testes de integração que mudavam o estado do membership diretamente passam a mudar o acesso e o membership juntos.

**Origem.** Pedido do maestro na issue #711, a partir da decisão de 2026-10-26 e das duas observações da revisão do PR #720. O desenho do trigger por estado, a leitura por `cliente.remover_usuario` e a remoção da coluna são da implementação.

**Validação.** Pendente de validação do dono.
