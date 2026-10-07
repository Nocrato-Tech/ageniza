# O job de encerramento roda na inicialização do worker e de hora em hora

**Data.** 2026-10-07

**Contexto.** A #133 pedia `clients.archive-due` uma vez por dia, às 00:10 em `America/Sao_Paulo`. O pg-boss envia o job quando o horário chega e **não repõe** o tick de uma hora em que nenhum worker estava no ar (um deploy ou uma queda às 00:10). Com o agendamento só diário, o portal de um contrato vencido ficaria aberto por cerca de 24 horas, o que a SPEC (`specs/clientes.md` seção 4: o portal fecha) não admite. A revisão de segurança do PR #387 apontou isso e o maestro decidiu.

**Decisão.**

1. O job roda **aos 10 minutos de cada hora** em `America/Sao_Paulo` (`10 * * * *`), o que inclui as 00:10, e **uma vez cada vez que o worker sobe**, depois de registrar o tratador. O nome `clients.archive-due` e o desenho não mudam: continua sendo só o relógio sobre `app_private.archive_due_clients()`.
2. A função é idempotente e só arquiva `closing_date` anterior a hoje, então rodar mais vezes não tem outro efeito: uma execução sem nada vencido arquiva zero, não escreve e não grava evento. Dois workers subindo juntos enviam dois jobs, e o segundo arquiva zero.
3. Na fila isso é a opção `runOnStart` da definição do job, genérica, ao lado de `schedule`. Quem declara `runOnStart` aceita ser executado a cada inicialização.

**Consequência.** O atraso máximo entre o fim do contrato e o portal fechado cai de ~24 horas para ~1 hora com o worker no ar, e para o tempo de subir o worker se ele esteve parado. O custo é uma consulta por hora e uma linha de log por execução (`archived`, sem dado pessoal). A SPEC (seção 8) e o guia de ambiente local foram ajustados. Não muda tabela, policy, *grant* nem migration.

**Origem.** Revisão de segurança do PR #387 (issue #133), decisão do maestro.

**Validação.** Pendente de validação do dono.
