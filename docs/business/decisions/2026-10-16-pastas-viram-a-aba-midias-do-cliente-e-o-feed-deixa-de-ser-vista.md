# Pastas viram a aba Mídias do cliente e o feed deixa de ser vista de Conteúdos

**Data.** 2026-10-16

**Contexto.** A tela de Conteúdos de um cliente (`/agencia/:agenciaId/conteudos/:clienteId`, e a aba Conteúdos do detalhe, que mostra a mesma visão) tinha um seletor de três vistas: Calendário, Feed e Pastas (decisões de 2026-10-11, "O feed da agência é a grade do período e vista própria" e "A aba do cliente é a mesma visão"). Em teste manual, em 2026-10-16, o dono viu que o celular desenhado à direita do calendário já é o feed, e que a vista Feed repetia a mesma grade no lugar do calendário. Perguntado onde ficariam as pastas, que só eram alcançáveis por essa vista (`?vista=pastas`), decidiu que ganham um lugar próprio.

**Decisão.**
- O seletor de vistas **sai inteiro** da tela de Conteúdos e da aba Conteúdos. Elas mostram só o calendário e o celular com o feed ao lado; o feed não é mais uma vista que troca o calendário.
- As pastas e as mídias do cliente passam a ser uma **aba nova do detalhe do cliente, "Mídias"**, logo depois de "Conteúdos", no endereço `/agencia/:agenciaId/clientes/:clienteId/midias`. O caminho da pasta aberta continua nos parâmetros `pasta`, `subpasta` e `pagina` do endereço, e o envio, a remoção e a criação de pastas não mudam.
- As **permissões são as da vista de pastas de hoje**: ver exige `conteudo.visualizar` (somada à `cliente.visualizar` do detalhe), e criar pasta e enviar ou remover mídia exige `conteudo.operar`, com o cliente ativo. Sem `conteudo.visualizar` a aba não aparece e o endereço dela cai no mesmo "não encontrado" da página inteira, como a aba Conteúdos.
- O endereço antigo `?vista=pastas`, na tela de Conteúdos e na aba Conteúdos, **redireciona** (substituindo a entrada do histórico) para a aba Mídias, levando `pasta`, `subpasta`, `pagina` e o estado de navegação da carteira, e descartando o que é do calendário. `?vista=feed` deixa de ter efeito e abre o calendário.

**Substitui em parte** as decisões de 2026-10-11 `conteudo-feed-da-agencia-grade-do-periodo-e-vista-propria` (a vista Feed própria; a grade do período, que segue como o celular ao lado do calendário, não muda) e `conteudo-a-aba-do-cliente-e-a-mesma-visao-e-os-numeros-do-card-da-carteira` (a aba Conteúdos continua sendo a mesma visão da tela de Conteúdos, que agora é só calendário e celular), que não se editam.

**Consequência.** Não há migration, policy nem rota de API: a API de pastas e mídia já tinha as permissões acima. É mudança de endereço e de tela: a aba Mídias entra em `specs/clientes.md` (seção 7) e a tela de Conteúdos perde a vista em `specs/conteudo.md` (seção 7), ambas acertadas no mesmo PR. Quem tinha o endereço antigo salvo continua chegando às pastas pelo redirecionamento. Os testes do seletor de vistas saem, e os da navegação de pastas passam a abrir pela aba nova.

**Origem.** Teste manual do dono em 2026-10-16; issue #703.

**Validação.** Pendente de validação do dono.
