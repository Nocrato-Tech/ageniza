# Conteúdo: o item Conteúdos da agência exige ler conteúdo e ler a carteira

**Data.** 2026-10-11

**Contexto.** A SPEC (`specs/conteudo.md` §2 e §7) diz que a tela de Conteúdos é para quem tem `conteudo.visualizar`, e que o seletor em stories mostra os clientes na ordem da carteira. Mas a lista de clientes é uma rota de `cliente.visualizar`. Um cargo personalizado com só `conteudo.visualizar` abriria a tela e levaria 403 na lista de clientes, sem como escolher um cliente. Todos os papéis predefinidos têm as duas permissões; só o cargo personalizado cai nesse caso.

**Decisão.**
1. O item **Conteúdos** do menu e as rotas `/agencia/:agenciaId/conteudos` e `/conteudos/:clienteId` exigem `conteudo.visualizar` **e** `cliente.visualizar`.
2. Quem tem só uma das duas não vê o item, e a URL digitada cai no mesmo "não encontrado" de qualquer endereço inexistente. Nenhuma chamada de conteúdo ou de carteira sai do navegador.
3. É regra de menu e de rota (UX); a autorização continua no backend, onde cada rota pede a sua permissão.

**Consequência.**
- Quem montar um cargo personalizado e quiser que ele use o calendário precisa dar as duas permissões.
- As telas seguintes de Conteúdos da agência (feed, pastas, modal) herdam a mesma regra, porque entram na mesma rota.
- A aba Conteúdos do detalhe do cliente (`/clientes/:clienteId/conteudos`) já exige `cliente.visualizar`, e fica de fora desta decisão.

**Origem.** Revisão do PR #544 (parte A da #262), decidido pelo maestro.

**Validação.** Pendente de validação do dono.
