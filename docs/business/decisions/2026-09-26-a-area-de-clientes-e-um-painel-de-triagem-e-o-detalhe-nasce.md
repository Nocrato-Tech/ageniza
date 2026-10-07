# A área de clientes é um painel de triagem, e o detalhe nasce com todas as abas
**Data.** 2026-09-26

**Contexto.** Quem abre Clientes na agência é, tipicamente, o Gestor de conta com oito a vinte clientes, várias vezes por dia, perguntando "qual cliente precisa de mim agora?". No MVP, porém, os sinais que responderiam isso — pendente, em revisão, atrasado — só existem depois de Conteúdo e Tarefas.

**Decisão.**

- **Intenção da área da agência**: o verbo é **triar**. A tela funciona como painel de plantão — o cliente com problema salta aos olhos, o cliente em dia fica quieto.
- **Intenção do portal**: o dono do negócio, sem familiaridade com ferramenta de agência, entrando pelo celular poucas vezes por semana para **conferir e aprovar**. Vitrine do trabalho, sem termo técnico, sempre com uma próxima ação óbvia. **O portal é pensado primeiro para celular**; a área da agência, para desktop.
- **Listagem `/clientes`**: 20 por página; ordem padrão **clientes com thread aberta pelo cliente primeiro, depois nome ascendente** — atraso passa a ser o primeiro critério quando Conteúdo existir; busca por nome, razão social e @; filtro de status ativos (padrão) e arquivados. O card mostra foto ou iniciais, nome, @, os selos *encerra em dd/mm*, *N sugestões aguardando* e *convite pendente*, e a faixa de indicadores reservada. Vazio: "Nenhum cliente ainda", com **Cadastrar cliente** para quem tem permissão.
- **Cadastrar** é um modal curto, só com o nome; ao salvar, abre o detalhe do cliente novo, onde **Editar** tem todos os campos.
- **Detalhe `/clientes/:id`**: cabeçalho com foto, nome, @, status e selo de encerramento, **Editar** com `cliente.operar` e o menu **Encerrar contrato** e **Arquivar/Reativar** com `cliente.arquivar`. **Todas as abas nascem no MVP** — Geral, Conteúdos, Tarefas, Estudo de marca, Relatórios e Acessos, esta só para quem tem `cliente.convidar_usuario`. As que dependem de módulo futuro nascem como **esqueleto**, preenchidas conforme os módulos entram.

**Consequência.** A ordem por "espera resposta" é o que torna a tela útil antes de Conteúdo. Aba esqueleto não pode mostrar dado fictício nem controle que não funciona: mostra que a área existe e o que virá, e nada que pareça quebrado. O custo aceito é conviver com abas sem uso até seus módulos entrarem.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

