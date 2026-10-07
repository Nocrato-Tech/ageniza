# Credencial correta sem nenhum contexto não cria sessão

**Data.** 2026-09-24

**Contexto.** Hoje `POST /auth/login` cria sessão para qualquer credencial válida, e `GET /me/contexts/resolve` responde `none` quando a pessoa não tem agência nem cliente — o que acontece com quem foi removido de todas as agências. O resultado é alguém autenticado dentro de uma aplicação sem nada.

**Decisão.** Autenticar primeiro, negar depois. Senha errada continua devolvendo o genérico de credencial inválida; senha **correta com zero contextos** devolve mensagem própria — acesso encerrado, procure quem administra a agência — e **nenhuma sessão é criada**. Isso não revela quais e-mails têm conta: quem chegou a esse ponto já provou que sabe a senha.

A regra é cobrada **no login e na resolução de contexto**, não no guard de sessão. Cobrar em toda requisição custaria uma consulta a mais para sempre, e é desnecessário: `requireAgencyAccess` e `requireClientAccess` já devolvem 404 para tudo que a pessoa não alcança, então uma sessão sem contexto já é inofensiva. O que faltava não era barrar acesso, era não deixar a pessoa presa.

**Consequência.** É **mudança de contrato numa rota implantada**: o comportamento de `POST /auth/login` muda e seus testes de integração mudam junto. A conta continua existindo, então um convite novo para o mesmo e-mail volta a funcionar pelo fluxo de conta existente — não é exclusão, é acesso sem vínculo.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

