# Checklist do implementador

> **Nível de risco:** use só a seção da área que o PR toca. As automutações valem para os níveis Médio (regra nova) e Alto; no Baixo não há mutação (ver a seção Níveis de risco do [AGENTS.md](../AGENTS.md)).

Passe por este checklist antes de abrir ou atualizar um PR. Cada item nasceu de um
achado real de revisão ou de uma regra de ambiente; o teste que continua verde sem a
regra é o erro mais repetido.

## Geral

1. **Automutação obrigatória.** Para cada regra e cada aceite, apague ou inverta a linha que o implementa, veja o teste ficar vermelho, reponha e liste a mutação no PR (#282, #291, #293, #298, #300).
2. **Isolamento.** Monte o cenário com uma situação em que a RLS **mostra** a linha (pessoa com vínculo em duas agências); senão a RLS esconde a falta do filtro (#186, #293). Escrita em recurso alheio confere o estado no banco, não só o status 404 (#282).
3. **Autorização.** Teste com papel personalizado de uma permissão só, e com o dono sem papel atribuído (`owner_user_id`) (#291, #298).
4. **Typecheck depois do develop.** Ao trazer o develop, rode `pnpm typecheck` mesmo sem conflito: contrato muda e mescla limpo (#209 `routeQuery`/`routeBody`/`routeResponse`; #201 `app_private.bind_actor`) (#282, #291, #294).
5. **Valor por valor.** O teste fixa o esperado por valor; nunca itera a própria constante que deveria verificar (#300).
6. **"X não acontece" é checado.** Aceite do tipo "não acontece" (ex.: pacote fora da imagem) precisa de checagem automatizada que falhe (#300).
7. **Cada catch de banco tem teste.** `42501`, `23505`, `40P01` — teste provoca o erro e confere o 4xx e a linha intacta (#282).
8. **Trigger e RLS usam `42501`.** Teste que só exige o código não distingue os dois: quando a regra é do trigger, confira a mensagem dele (#294).
9. **Locker de concorrência.** A transação que trava a linha afirma `rows=1`; sem isso, sem ator, a RLS faz do teste de concorrência um vazio verde (#202).
10. **Guarda montada à mão.** A rota deriva a guarda do próprio `docs` (`docs.permission`) e tem teste de 403 com papel de uma permissão só; papel vazio não prova a guarda (#293).
11. **Listagem.** Desempate de ordenação, busca mínima (ex.: `@` sozinho) e contagem e página no mesmo snapshot com `count(*) over ()` (#291, #293, #298).
12. **Decisão no mesmo PR.** Regra de negócio nova vira um arquivo novo em `docs/business/decisions/` no mesmo PR (#282). O índice `docs/business/decisions/README.md` não entra no PR de entrega: é regenerado com `pnpm docs:decisions-index` ao fim de cada onda, num PR de docs (decisão `2026-10-11-indice-de-decisoes-gerado-por-script-fora-dos-prs`).
13. **Pasta e banco próprios.** Agente em paralelo usa a própria pasta e o próprio banco `ageniza_<id>`; o banco `ageniza` é o do ambiente local do dono.
14. **Borda com filtro.** Paginação além do fim e recontagem testadas com e sem busca: busca com resultado e `page` além do fim responde o total filtrado (#415).
15. **Lista truncada.** Quando a tela lê só os N primeiros, um teste passa do limite (51 comentários, 101 conversas) e confere que o mais recente e a resposta nova aparecem (#413).
16. **Estados da tela.** Carregando, erro e vazio têm teste com asserção do texto; Esc num modal dentro de outro fecha só o de cima (#413).
17. **Timers e eventos no web.** Três testes: sobreposição (resposta segurada por uma promise, eventos repetidos, uma chamada só), vazamento (evento disparado depois de desmontar não chama nada) e ausência de sessão (nada roda) (#419).
18. **Efeito colateral numa transação.** Decida o efeito (ex.: revogar sessão) pelo que a transação escreveu, nunca por uma leitura sem trava anterior. O teste de atomicidade injeta uma falha DEPOIS da escrita (trigger que faz o passo seguinte falhar) e confere que nada ficou (#417).
19. **Guard reaproveitado.** Rota nova que reusa um guard com uma opção tem teste de cada regra do guard naquela rota (#417, #423).
20. **A decisão descreve o código de verdade.** Afirmação como "a tela já faz X" ou "a decisão Y diz Z" é conferida no código e no texto citado antes de registrar; depois do merge o arquivo não se edita (#414, #420).
21. **API e tela são subtarefas separadas.** Mesmo quando a issue pede as duas, cada uma tem a sua revisão antes de entrar na integração; vão no mesmo PR do escopo (#417, #419).
22. **Harness no banco certo.** Antes de rodar a integração, exporte `DATABASE_URL` e `MIGRATION_DATABASE_URL` apontando para o seu banco: sem elas, ou com um banco chamado `ageniza`, o harness recusa e diz o motivo (#391). Harness novo obtém as URLs só por `resolveIntegrationDatabaseUrls`, nunca com `?? 'postgresql://...'`.
23. **Caractere invisível.** A regra de invisível não fica só em `\p{Cf}`: inclua `Default_Ignorable_Code_Point` (CGJ, seletores de variação, FVS) e brancos que são símbolo (U+2800) (#426).
24. **Mutação por ponto de chamada.** Quando um helper protege várias rotas, mute cada chamada, não só o helper; mutar o helper esconde a rota que ficou sem teste (#426).
25. **Tabela nova declara os próprios grants.** O `ageniza_app` não tem privilégio padrão em tabela nova de `public` nem de `auth`: a migration que cria a tabela concede, por coluna no `INSERT` e no `UPDATE`, só o que uma rota ou o worker faz, e nunca `DELETE` em entidade de negócio. O teste de catálogo de `least-privilege-grants.integration.test.ts` reprova o grant de tabela inteira (#372).

## Banco

_Ver também os itens 7 a 9 e 25, que estão na faixa Geral._

26. **Estado, ator e datas fora do grant.** `status`, `archived_at`, `resolved_by`, `resolved_at` e `created_at` não entram no `GRANT` de `INSERT`/`UPDATE`; quem os carimba é uma função ou um trigger `BEFORE UPDATE` com `OLD`/`NEW` em `security invoker`, e o teste exercita a transição, não só a coluna (#159, #162).
27. **Escrita exige leitura.** Um `UPDATE` com `WHERE` ou `RETURNING` sobre uma coluna exige `SELECT` nela. O teste de escrita roda com o papel de uma permissão só, senão a falta do `SELECT` some atrás de um papel com mais privilégio.
28. **Lock de linha depende do `UPDATE`.** Revogar `UPDATE` tira o `SELECT ... FOR UPDATE` que a função usa. A trava é conferida com o papel `ageniza_app`, e a transação afirma `rows=1` (ver item 9).
29. **Dia de negócio com instante fixo.** O dia de São Paulo sai de `app_private.sao_paulo_date` com um instante fixo no teste. `current_date` e `now()` solto numa regra de data são reprovados.
30. **Filha de cliente trava o cliente.** Insert em filha do cliente passa pelo gatilho `AFTER INSERT ... FOR SHARE` no cliente. A rota testa as duas janelas da corrida com o arquivamento: arquivamento em curso (A0020 do gatilho: 409 na agência e 404 no portal) e já confirmado antes do `INSERT` (42501 da RLS), e relê o cliente depois das travas (#406).
31. **Trava com releitura só vale em READ COMMITTED.** A função recusa outro isolamento com `40001`, e o teste de corrida tem variantes em REPEATABLE READ e SERIALIZABLE, com upsert e `MERGE` (#393, #394).
32. **`CHECK` que chama função não é reavaliado.** Quando a função muda, apertar a regra exige `DROP` e `ADD` da constraint depois do backfill (#482).
33. **Grant de tabela inteira.** Complementa o item 25: use `has_table_privilege` (enxerga `PUBLIC` e herança, e ignora grant por coluna) e compare um snapshot do catálogo antes e depois da migration (#502).
59. **Bind de ator primeiro.** Lição registrada pela Coruja na revisão de segurança do #407, não achado do PR. Função do worker que recusa ator ligado só confere no momento da chamada; o que fecha a porta para a requisição é o `bind` do ator como primeira instrução da transação de topo. (#407).
60. **Migration antes da API.** A decisão estrutural vai junto quando a migration é estrutural (o gate exige), e a subtarefa da migration entra na integração antes da subtarefa da API que a usa: código que lê o retorno novo de uma função falha se vier o tipo antigo (#406, #530).
61. **Releitura depois da última espera.** Ler o estado do pai "depois das travas" só fecha a janela se a leitura vier depois da última espera antes da escrita. Num `UPDATE` sem policy de cliente ativo, quem fecha o resto é o gatilho do banco. Complementa o item 30 (#541).
62. **Gatilho com erro em UPDATE de rota existente.** Gatilho novo que levanta erro num `UPDATE` já usado por rota existente exige achar e testar cada rota que faz esse `UPDATE` antes do merge: a revisão do #545 achou, antes do merge, que o gatilho novo faria o `PATCH` de persona dar 500 (#545).
63. **Lista de colunas do gatilho contra o grant.** Lista de colunas escrita à mão num gatilho precisa de teste de catálogo contra o grant (`tgattr` x `has_column_privilege`); senão coluna gravável nova escapa sem vermelho. Complementa o item 33 (#538).
67. **Corrida com trava segurada.** Na trava de linha (tuple lock), o 2º waiter é bloqueado pelo 1º waiter, não pelo holder: esperar N bloqueados pelo pid do holder trava; conte `cardinality(pg_blocking_pids) > 0` (#555). Na trava consultiva, o holder bloqueia os dois waiters, e a contagem pelo pid do holder vale.
92. **Array de uuid na função.** Função que recebe `uuid[]` confere `array_ndims(p) = 1` antes de `array_position` ou `unnest`: um array de duas dimensões passa pelo tipo e quebra com `0A000` em vez do erro de negócio (telas-melhorias, onda 1).
93. **Função que recebe um instante.** Função que a aplicação pode executar não recebe o instante de fora: um instante passado refaz dias antigos. O instante fica numa variante interna (`…_at(p_at)`, só do dono, para teste) e a aplicação chama a versão sem argumento, que usa `now()` (telas-melhorias, onda 1).
94. **Campo gravado por dois caminhos.** Campo novo gravado por mais de um caminho (com conta e só pelo link) tem a invariante do contrato conferida contra cada caminho, e todos os seus consumidores listados (rótulo, botão, regra do banco) antes de a tela usá-lo (telas-melhorias, onda 2).

## API e portal

34. **Pessoa dupla em toda rota de portal.** A rota tem teste com `dualBare` e `crossDual`. Cláusula que só o lado cliente exerce é provada com a pessoa dupla, porque o portal puro nunca chega a ela (#485).
35. **Nome e foto pelo vínculo.** O nome e a foto mostrados no portal vêm do vínculo da pessoa, nunca da conta global de quem aceitou o convite.
36. **Erros do banco mapeados.** Além de `42501`, `23505` e `40P01` (item 7), os `A00xx` dos gatilhos viram 4xx. Nenhum erro de banco chega como 500, e o teste provoca cada um.
37. **Paridade entre Zod e jsonb.** Um caso de surrogate isolado (um `\uD800` sozinho) é aceito pelo JS e recusado pelo jsonb. Sem esse caso, a paridade não está provada (#482).
38. **Header fora da rota não cobre tudo.** Header posto no `onRequest` da rota não aparece em `frameworkErrors`, em hooks globais nem no preflight. Se precisa estar em toda resposta, vai num hook global e no `frameworkErrors` (#490).
64. **Texto livre tem uma regra só.** Texto livre usa a regra única de `packages/contracts`: `hasInvisibleCharacters` em `invisible-characters.ts`, e `hasHiddenStoryCharacters` em `story-scripts.ts` para texto com quebras de linha. Nenhuma rota escreve a própria regra de caracteres. Emoji composto fica só no helper (#539), não na rota (#541, #542).

## Telas

_Ver também os itens 15 a 17, que estão na faixa Geral._

39. **Todo texto tem asserção positiva.** Cada texto que a tela mostra é conferido pelo próprio texto, não só pela ausência de erro. Cada navegação e cada parâmetro de URL têm um clique no teste.
40. **Estado da carteira em todo link.** Todo link interno da tela leva o `state` da carteira. O teste confere o parâmetro no `href` de cada um.
41. **Datas no dia de São Paulo.** Fixtures ficam em 01:30Z, que cai em outro dia em UTC. Assim, uma data calculada em UTC aparece como erro no teste.
42. **Tokens do design system.** Texto ou link sobre `bg-hover` não passa. Use só os tokens de `docs/design-system.md`.
43. **Nome acessível inclui o que se vê.** O nome acessível de um controle contém o texto visível dele, para que o rótulo e o que a pessoa lê não divirjam.
44. **Modal fecha no sucesso e não apaga o digitado.** O teste confirma que o sucesso fecha o modal e que o erro mantém o texto já digitado.
45. **Ação age no item certo.** Teste com duas linhas: a ação na segunda não pode alterar a primeira.
46. **Aviso de uso único e barra sticky.** O aviso de uso único é conferido depois dos redirects e da casca assentarem. A barra inferior sticky é conferida a 360 px com conteúdo curto (#401).
47. **Tela grande se divide no plano.** Não há teto de diff no PR (decisão `2026-11-06-um-pr-por-escopo-com-revisao-por-subtarefa`); a subtarefa grande é que se divide, e numa tela com abas a divisão natural é por aba.

72. **Campo de credencial.** Em redesign de tela de autenticação (login, recuperação, redefinição, convite, troca de e-mail), um teste em tabela fixa `type`, `autocomplete` e `name` de cada campo de credencial, e `target` e `rel="noreferrer"` dos links externos. A refatoração visual troca a marcação inteira e nada na tela mostra a regressão: senha como `text`, `autocomplete` desligado ou trocado entre `current-password` e `new-password`, `name` renomeado. Mute cada atributo de cada campo, não só um por tela (#656).

73. **Tooltip que vira Popover.** Quando um tooltip vira `Popover`, o elemento que recebe o foco continua descrito pelo cartão (`aria-describedby` com o id do cartão enquanto aberto, e sem ele depois do Esc), e o teste do vínculo não some na troca de role: troque `tooltip` por `dialog` na asserção, nunca a apague. Passar `aria-expanded` e `aria-controls` para outro elemento (o link de dentro do card) não substitui a descrição de quem tem o foco, e o leitor de tela só lê o cartão se ela existir (#668).

74. **Clique duplo na mesma tarefa.** Guarda de clique duplo que lê o estado do TanStack Query (`isPending`) não cobre dois cliques na mesma tarefa: o estado só muda no render seguinte, e os dois cliques o veem falso. Para a garantia, a guarda é um `useRef` síncrono, posto antes do `mutate` e solto no `onSettled`. O teste dispara os dois cliques dentro de um só `act` (sem render entre eles) e afirma uma só chamada; o que o `isPending` sozinho deixa passar fica vermelho (#639, achado da Coruja no #675).

86. **Fechar formulário com dado digitado pede confirmação.** Prova: teste de Esc, clique fora e X, cada um com e sem dado. Com dado abre a confirmação e nada fecha; sem dado fecha direto; o sucesso fecha sem perguntar (decisão `2026-11-10-cartao-de-conteudo-enxuto-e-fechamento-seguro-de-formulario`).

87. **Vazio só afirma "nada pendente" com a consulta ok e completa.** Prova: teste com a consulta falhando mostra a falha com "Tentar de novo", nunca o vazio de boa notícia; a tela cobre todos os estados pendentes (decisão `2026-11-10-tres-tipos-de-estado-vazio`).

88. **Cartão de conteúdo enxuto.** Mostra título, uma linha de apoio e o estado; o resto fica no cartão de passar o mouse. Prova: asserção do que fica e do que saiu, e captura em 1440 e 390 sem nada fora da tela.

89. **Estado nunca só por cor.** Todo estado leva ícone e texto. Prova: asserção do ícone e do texto de cada estado.

90. **Texto ao cliente fala em nome da agência.** Nunca vende o produto. Prova: asserção do texto positivo e leitura dele como a agência falando.

91. **O que não se usa toda semana não fica no primeiro nível do menu.** Prova: teste da navegação com os itens do primeiro nível e onde cada um dos demais mora.

## Testes e mutação

48. **Mutação que aplica migration.** Mutação com knex no mesmo processo usa um diretório por mutante e um controle sem mudança, por causa do cache de import do `.mjs` (#389).
49. **CRLF e contagem na mutação.** A mutação que troca texto normaliza CRLF antes de comparar e confere quantas ocorrências trocou. Sem isso, uma troca que não aconteceu passa como verde.
50. **Teste "redundante" só sai depois de mutar.** Rode o mutante sem ele antes de apagar. O `waitFor` que parecia sobrar era o único que segurava a regra (#456).
51. **Regra antiga não mascara a nova.** O caso de teste de uma regra nova não pode ser recusado também por uma regra mais antiga: confira o caso com a regra nova desligada (#440).
52. **Qualquer vínculo da pessoa.** Mutação de vínculo testa também "qualquer vínculo da pessoa", não só a remoção do `is_client_member` (#475).
53. **Regex de `CHECK`.** Na mutação de um `CHECK` por regex, troque a classe pela negação dos casos testados (`[^ @]`), e não só o quantificador (#478).
54. **Faixa de regex nos extremos.** Regex de intervalo testa os dois extremos de cada faixa. A mutação de fronteira sobrevive aos casos do meio (#487).
55. **Matriz de paridade completa.** Teste de paridade entre duas funções tem na matriz todo cenário que nega: agência suspensa, vínculo removido e duas agências (#505).
56. **Censo por regex com uma declaração.** Censo que procura "a variável recebeu o helper" precisa garantir uma declaração só, senão uma sombra o engana (#515).
57. **Lista permitida, não proibida.** Gate que só proíbe o que existe hoje pega a cópia, mas não o movimento. Use lista permitida fixa, cobrindo `dependencies`, `optional`, `peer` e todo pacote interno que entra na imagem. A regex de declaração ancora o fim (#511, #522).
58. **Soma com semente em outra agência.** O teste de soma mede o valor com uma semente em outra agência, para que um filtro de agência faltando apareça.
65. **Exceção tem teste das bordas.** Exceção aceita numa regra de caracteres precisa de teste das bordas dela (repetição, vizinhos, variantes), não só do caso feliz (#533).
66. **Corrida sem o gatilho fica vermelha.** Quando a proteção de uma rota vem de um gatilho de outro PR, o teste de corrida da rota tem de ficar vermelho sem esse gatilho; senão não prova nada sobre a rota (#542).
68. **Worktree recompila o contrato.** Rodar a API de um worktree pede recompilar `packages/contracts` quando o PR mexe nele; senão constante nova chega `undefined` e comparação numérica passa calada (#575). O risco é local (worktree): o CI compila os contratos antes dos testes.
69. **Nome de global do JS.** Componente exportado com nome de global do JS (`Symbol`, `Map`, `Image`, `Option`) passa no lint e só quebra quando outro arquivo o importa e sombreia a global. Use um nome composto (`BrandSymbol`) (#642).
70. **Foco em controle com loading.** O jsdom não aplica a regra do navegador que tira o foco de um elemento quando ele vira `disabled`: um controle com `loading` que usa `disabled` nativo passa em teste e perde o foco do teclado no navegador. Use `aria-disabled` com uma guarda no clique e teste que `document.activeElement` continua nele depois de entrar em loading, com `disabled` falso e `aria-disabled` verdadeiro (#644, #645).
71. **Cartão aberto por hover.** Cartão flutuante que abre ao passar o mouse precisa de teste da passagem do gatilho para o cartão: sair do gatilho, entrar no cartão dentro da tolerância e afirmar que continua aberto (WCAG 1.4.13, o conteúdo em hover precisa ser alcançável pelo ponteiro). O jsdom não tem geometria, então o vão entre o gatilho e o cartão só aparece no navegador real: confira no Chrome headless com perfil descartável, em `127.0.0.1`, movendo o mouse de 3 em 3 px pelo vão, e confira que nada corta o cartão (um contêiner com `overflow` esconde o que está fora dele e tira o cartão do caminho do mouse) (#650).

75. **Teste de deadlock fecha o ciclo dentro do banco.** O detector aborta quem espera há mais de `deadlock_timeout` (1 s) com o ciclo já fechado; se o holder só pede o segundo lock depois de um poll no Node, qualquer parada do processo de teste de mais de 1 s faz do holder a vítima e o teste falha com o 40P01 dele. O holder pede o lock por `requestLockOnceBlocked` (`@ageniza/database`), armado ANTES de iniciar a transação testada, e o teste espera os dois juntos (`Promise.all`). Poll em Node serve para soltar o holder (commit, rollback), nunca para fechar um ciclo. A prova é o atraso artificial de 1,5 s depois de a rota começar, que com o poll deixa o teste vermelho e com a barreira o deixa verde, e a mutação sem o mapeamento do `40P01` (#745, #762).

76. **Espera de bloqueio tem escopo, e ordem não vem de sleep.** Um poll de `pg_locks` ou de `wait_event_type = 'Lock'` sem escopo é satisfeito pela espera de outro banco do mesmo servidor ou de outro holder, e o teste segue antes de a transação testada bloquear. Quem ordena duas transações espera `waitForBackendsBlockedBy(observador, pidDoHolder)` (`@ageniza/database`), que só vê backends deste banco bloqueados por aquele pid e levanta quando ninguém espera; o pid vem de `backendPid`. Para a fila de lock atrás de um holder, `waitForQueueBehind` (`apps/api/src/modules/auth/test-support/lock-queue.ts`) espera a contagem deduplicada de backends na fila. Nunca `setTimeout` ou `pg_sleep` para "dar tempo": quando o que falta é o relógio do banco passar de um instante, o teste espera essa condição (`clock_timestamp() >= ...`). A prova é o atraso artificial antes do passo que dependia de sorte e a mutação que tira o filtro de pid ou troca a barreira por um sleep curto (#767).

77. **Teste de texto de workflow recorta o job inteiro.** O recorte de um job termina em qualquer chave de job válida, e o passo protegido é contado no workflow inteiro: ele aparece exatamente uma vez. Mover a suíte para um job novo tem de dar vermelho.

78. **Cache do turbo.** Só o push em `develop` salva o cache; PR só restaura, para um PR não envenenar o cache. `test` fica sem cache. O turbo rodado dentro de um worktree escreve no cache do checkout principal: o agente usa um `TURBO_CACHE_DIR` próprio.

79. **Gate que espera outro workflow.** Filtra o run pelo `.path` do arquivo, não pelo nome, e falha fechado em erro de leitura. O contrato tem teste.

80. **`gh api` escreve o erro no stdout.** Mesmo com `--jq`, o corpo do erro vai para o stdout: o retry guarda a saída de cada tentativa separada, e o fake da CLI no teste reproduz a saída real.

81. **Contagem de fila de lock.** Deduplica (`union`, não `union all`), e a prova inclui um controle negativo.

82. **Guard de configuração.** Importa a config e confere o valor; nunca faz grep no texto.

83. **Mutação por `git archive`.** O `git archive` aplica o autocrlf. Uma mutação cujo arquivo de teste não carrega mostra todo mutante como morto: confira que o teste rodou.

84. **Teste que depende do dia de São Paulo.** Quando a função lê `now()` por dentro e não dá para injetar o instante sem abrir a função `security definer`, o teste espera sair da borda da meia-noite (`waitForQuietClock`).

85. **Scratchpad e `%TEMP%` são compartilhados entre agentes.** Prefixo da subtarefa em tudo que criar, e apague só o que criou.
95. **Contagem global é instável.** Teste de função que age no banco inteiro (fila, lembretes) confere só o efeito nas linhas do próprio teste, ou roda num clone: o retorno global depende do que outro arquivo deixou no banco (telas-melhorias, onda 2).
96. **Dado plantado não vaza para suíte paralela.** Dado plantado para provar que o teste ignora o resto não pode ser pego por outra suíte que roda ao mesmo tempo, como uma fila reivindicada globalmente. Antes de plantar, confira que os arquivos rodam em série ou num clone (telas-melhorias, onda 2).
97. **Correção por configuração tem controle sem ela.** Quando a correção depende de configuração (arquivos em série), rode o controle com a configuração removida para saber se é ela ou a limpeza que corrige (telas-melhorias, onda 2).
98. **Trava que espera tem corrida real.** Trava cujo comentário diz "espera a operação em andamento" tem teste com duas transações reais segurando essa operação. Um teste de deadlock em outra tabela não pega a remoção da trava (telas-melhorias, onda 2).
99. **Data opcional digitada pela metade.** Campo de data opcional tem teste com ano de dois dígitos (`14/10/26`): a data incompleta bloqueia o envio com a mensagem do `DatePicker`, e nunca vira "sem data" (telas-melhorias, onda 4).
100. **Teste de isolamento espera a tela de destino.** Antes de afirmar que o dado de outro cliente não aparece, o teste espera a tela de destino terminar de carregar; afirmar ausência durante o carregamento passa sempre (telas-melhorias, onda 5).
101. **Falha que some na nova tentativa.** Com TanStack Query v5, consulta que nunca teve dado volta a `pending` ao tentar de novo: a falha continua montada com `isPending && errorUpdateCount > 0`, e o `EmptyState` recebe `retrying={isFetching}` (telas-melhorias, onda 5).
102. **Mutação da primeira leitura.** Tela com estado de falha tem a mutação "falha na primeira leitura" (sem dado anterior), além da falha depois de já ter dado (telas-melhorias, onda 5).
103. **Descarte por diálogo.** Cada sinal novo de "formulário com dado digitado" tem o seu teste de descarte no diálogo que o usa; o teste do `Dialog` sozinho não cobre o sinal (telas-melhorias, onda 4).

As lições completas de segurança estão em `docs/security-review.md` e nas notas do projeto; este checklist só lista o que mais se repete.
