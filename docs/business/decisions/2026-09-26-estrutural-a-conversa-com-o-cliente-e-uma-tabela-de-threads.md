# ESTRUTURAL: a conversa com o cliente é uma tabela de threads por cliente, com assunto tipado

**Data.** 2026-09-26

**Esta é uma mudança estrutural**, pelo critério de formato que outras rotas copiam: é o primeiro mecanismo de conversa entre cliente e equipe, e Conteúdo vai reaproveitá-lo.

**Contexto.** As threads do estudo de marca e, depois, as de conteúdo precisam da mesma RLS — só a agência e as pessoas daquele cliente — e da mesma contagem de "conversas aguardando resposta" que alimenta o card da listagem.

**Decisão.** **Uma tabela de threads** com `client_id` sempre preenchido e o assunto em **colunas tipadas com chave estrangeira** — a seção do estudo ou `persona_id` —, com restrição de exatamente um assunto por thread. Os comentários pendem da thread. A RLS é uma só, pelo `client_id`.

Descartadas: **uma tabela por assunto**, que duplicaria RLS e contagem a cada módulo; e a **polimórfica** com `subject_type` e `subject_id` sem chave estrangeira, que perde integridade e obriga a RLS a descobrir o dono do assunto em tempo de consulta.

**Consequência.** **Conteúdo acrescenta uma coluna `content_id`** a esta tabela — `alter table` aditivo que também passará pelo gate, e que já fica anunciado aqui. "Quantas conversas esperam resposta neste cliente" continua uma consulta só depois disso.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

