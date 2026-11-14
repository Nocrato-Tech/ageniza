# A busca da agência cobre clientes, conteúdos e arquivos pelo nome, e a do portal filtra os posts já carregados

**Data.** 2026-11-11

**Contexto.** O quadro do redesenho (r0) tem a busca em pílula "Buscar cliente, conteúdo ou arquivo" (Ctrl K) na barra superior da agência e "Buscar um post" no portal. Hoje cada tela só busca dentro de si (a carteira, a Equipe). A decisão [`2026-10-14-navegacao-da-agencia-sem-ajustes-ate-existir-a-tela`](2026-10-14-navegacao-da-agencia-sem-ajustes-ate-existir-a-tela.md) proíbe controle sem destino, então a busca só entra com uma tela e uma SPEC.

**Decisão.**

1. **Agência: três tipos, pelo nome.** A busca da barra superior procura **clientes** (nome, razão social e @, como a carteira), **conteúdos** (título) e **arquivos** (nome do arquivo), em todos os clientes da agência, e mostra os resultados em grupos.
2. **Cada grupo respeita a permissão do tipo.** Clientes com `cliente.visualizar`; conteúdos e arquivos com `conteudo.visualizar`. O grupo que a pessoa não pode ler **não aparece e não é dito que existe**: a busca nunca serve de oráculo de nomes. Não busca pessoas da equipe, nem conversas, nem texto de legenda.
3. **Sob a RLS.** A leitura roda com a pessoa ligada na transação, como as demais; nenhum resultado vem de uma função que contorne a RLS. Cliente arquivado aparece (marcado); arquivo removido não.
4. **Forma.** No mínimo 2 caracteres, até 80; poucos resultados por grupo e sem paginação (quem quer mais refina). O termo não é registrado em log. Há limite de requisições por pessoa.
5. **Ctrl K** abre a busca em qualquer tela da agência; cada resultado leva à tela do tipo (o cliente, o conteúdo no calendário do cliente, o arquivo na aba Mídias).
6. **Portal: filtro no navegador.** "Buscar um post" **não chama a API**: filtra pelo título os posts que a tela de Conteúdos já carregou (o mês aberto). Das outras telas, a busca leva a Conteúdos com o termo. Não há rota nova nem leitura nova.

**Substitui.** Nada. É uma regra nova, que respeita [`2026-10-14-navegacao-da-agencia-sem-ajustes-ate-existir-a-tela`](2026-10-14-navegacao-da-agencia-sem-ajustes-ate-existir-a-tela.md) por ter tela e destino em cada resultado.

**Consequência.**

- Não é estrutural: nenhuma tabela, policy ou permissão muda. É módulo novo de leitura (`search`), com SPEC em `specs/busca.md`; pode precisar de índice, que é migration nova sem tocar o que existe.
- **Risco: Alto** pela leitura entre módulos que devolve nomes de clientes de uma agência. Pede revisão de segurança independente: a prova é que quem não lê um tipo recebe a mesma resposta de quem lê e não acha nada, e que outra agência nunca aparece.
- O fluxo mobile da agência descreve a busca; o do portal descreve o filtro.

**Origem.** Pedido do dono do produto em 2026-11-11 ("tudo igual ao quadro") e decisão do maestro sobre o que a busca cobre.

**Validação.** Validada pelo dono em 2026-11-12.
