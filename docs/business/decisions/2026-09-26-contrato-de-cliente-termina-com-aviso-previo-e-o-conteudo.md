# Contrato de cliente termina com aviso prévio, e o conteúdo além da data é cancelado

**Data.** 2026-09-26

**Contexto.** Ao pré-decidir o que acontece com conteúdo agendado de cliente arquivado, a regra dada foi "só publica até o começo da desativação; o que vier depois se cancela". Isso pressupõe uma desativação com data futura, que a decisão de estados não previa — ali, arquivar era sempre imediato.

**Decisão.** O cliente pode ter uma **data de encerramento**, registrada por quem tem `cliente.arquivar`. Até ela tudo funciona normalmente — **inclusive o portal**, porque o cliente ainda está no período contratado —, com aviso visível na área da agência. Na data, um **job arquiva o cliente**, com os mesmos efeitos do arquivamento manual. O encerramento pode ser **desmarcado** até a data. Arquivar na hora continua existindo, e equivale ao encerramento com a data de hoje.

Regra **pré-decidida para Conteúdo**: conteúdo com publicação **até** a data de encerramento publica normalmente; o que estiver **depois** é **cancelado** quando o cliente é arquivado. Sai do agendamento e **não volta sozinho** na reativação — a agência reagenda o que quiser. Cancelado não é excluído: o conteúdo continua guardado, com esse status. Cliente arquivado não executa nenhuma ação externa em nome dele, como já vale para agência suspensa.

Foram descartados o arquivamento sempre imediato, que obrigaria alguém a lembrar do dia certo, e o conteúdo suspenso que volta sozinho, porque um post reaparecendo meses depois com data vencida é pior que reagendar.

**Consequência.** É o **primeiro job agendado de negócio** do sistema, e ele esbarra na decisão de que o worker não contorna a RLS: precisa agir como alguém. Com que identidade ele arquiva é tratado no bloco de impacto estrutural desta entrevista.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

