# Conteúdo: a aba Atribuição do modal, quem age em cada subtarefa e quem troca o responsável

**Data.** 2026-10-11

**Contexto.** A #265 põe no modal do conteúdo a aba Atribuição: o responsável do conteúdo e a lista de subtarefas (`specs/conteudo.md` seções 2, 3, 4 e 7). A API já traz tudo (#255, #552, #561): o responsável do conteúdo e o da subtarefa são ditos por vínculo (`{ membershipId, name }`), entregar, aprovar e devolver pedem só `conteudo.visualizar` e decidem pelo valor da linha, e trocar o responsável do conteúdo pede `conteudo.aprovar_pela_agencia`. O que a SPEC e a API não fecham para a tela, e alguém tentaria de novo:

**Decisão.**

1. **Quem é "a pessoa da sessão" vem do `/me`.** A tela compara o `membershipId` do contexto da agência com o `owner` do conteúdo e com o `assignee` de cada subtarefa. Para o Owner por posse, que não tem vínculo, o `membershipId` é `null`: a tela o trata como "não é o responsável" e decide pelas permissões. Nenhuma tela lê a lista de colaboradores para saber quem é a pessoa.
2. **Entregar** aparece só na subtarefa pendente cujo responsável é a pessoa da sessão, e em nenhuma outra, qualquer que seja o papel (como na API, o Admin e o Owner inclusive não entregam o que é de outra pessoa).
3. **Aprovar e Devolver** aparecem só na subtarefa entregue, para o responsável do conteúdo ou para quem tem `conteudo.aprovar_pela_agencia`. Devolver abre o comentário e só envia com ele, pela regra única de texto livre do contrato (`ReturnContentTaskRequestSchema`); a recusa tem texto da tela, e o digitado fica no erro. O comentário volta na subtarefa como "Devolvida: …" enquanto ela está pendente.
4. **Trocar o responsável do conteúdo** pede `conteudo.operar` **e** `conteudo.aprovar_pela_agencia` (a rota pede a primeira e o campo, a segunda). A issue dizia "trocável por quem opera"; vale a regra da API (#561), e quem só opera vê o responsável, sem o controle.
5. **Criar subtarefa** (`conteudo.operar`) entra nesta aba, com título, responsável, prazo e descrição opcional; **editar** uma subtarefa existente (a rota `PATCH` existe) fica para outra issue. No teto de 50 a tela não oferece "Nova subtarefa" e diz "Um conteúdo leva no máximo 50 subtarefas."; se a tela estava velha e a API responde `409 CONTENT_TASK_LIMIT`, o texto é o mesmo.
6. **Quem escolhe a pessoa** a escolhe pelo nome (com o cargo, se houver) numa lista lida de `GET /collaborators`, que pede `colaborador.visualizar`; sem ela a tela diz isso e não oferece a escolha. Quem pode ser responsável é decisão da API (colaborador ativo que vê Conteúdo): a tela só traduz o `400` em "A pessoa escolhida não pode ser responsável: precisa estar ativa e poder ver Conteúdo."
7. **Só leitura** em cliente arquivado e em conteúdo publicado ou cancelado: a lista e o percentual aparecem, nenhum botão.
8. **O percentual** é o texto "N de M aprovadas (P%)" (arredondado), só com subtarefas; "Nenhuma subtarefa ainda." sem elas. O atraso de uma subtarefa é derivado no dia de São Paulo: prazo anterior a hoje e não aprovada.
9. **Nenhum id na tela**; o formulário de Geral continua montado (e com o digitado) enquanto a aba Atribuição está aberta, e a aba só existe para um conteúdo já criado.

**Consequência.**

- A tela depende de `membershipId` no `/me` (PR do Quartzo): sem ele a pessoa nunca é reconhecida como responsável, e só as permissões decidem Aprovar e Devolver.
- Quem criar um papel personalizado que opere e aprove precisa dar também `colaborador.visualizar` para trocar o responsável ou criar subtarefas.
- Se o dono quiser que quem só opera troque o responsável, é decisão estrutural de autorização na API, não de tela.

**Origem.** Issue #265; SPEC `specs/conteudo.md` seções 2 a 4 e 7; #255 (subtarefas), #552 e #561 (responsável por vínculo); pedido do maestro de usar `me.membershipId`.

**Validação.** Pendente de validação do dono.
