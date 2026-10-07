# ESTRUTURAL: arquivar cliente é uma função `security definer` de escopo único, usada pelo job e pela rota
**Data.** 2026-09-26

**Esta é uma mudança estrutural**, por mudar **como a autorização é avaliada** para trabalho sem requisição: abre uma exceção à decisão de 18/09 de que o worker age como um usuário e não contorna a RLS.

**Contexto.** O encerramento agendado precisa de um job que arquive o cliente na data. Pelo modelo atual ele agiria como quem agendou, e o defeito já registrado para a mídia se repetiria com consequência pior: se essa pessoa perder a permissão, o job vira no-op silencioso, **o contrato não se encerra e o portal continua aberto**. Havia um segundo acoplamento: arquivar revoga convites pendentes, o que exige permissão sobre `invitations`, que `cliente.arquivar` não implica.

**Decisão.** Uma função `security definer` que faz **uma coisa só**: arquiva o cliente, revoga os convites pendentes dele e grava um evento em `audit.events`. O **job** a chama apenas para clientes com data de encerramento vencida. A **rota de arquivar** chama a mesma função, depois de a API conferir `cliente.arquivar` — os dois caminhos têm exatamente o mesmo efeito.

**Consequência.** A regra "o worker não contorna a RLS" passa a ter uma exceção documentada: **função de escopo único, auditada, chamável só para o efeito que nomeia** — nunca uma identidade de serviço com acesso amplo. Esse é o **modelo que a publicação agendada de Conteúdo deve seguir**, e qualquer exceção nova precisa ter a mesma forma. O defeito da mídia, que continua agindo como o usuário, não é corrigido por esta decisão.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

