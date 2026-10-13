# Checklist do implementador

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
21. **API e tela em PRs separados.** Mesmo quando a issue pede as duas (#417, #419).
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
60. **Migration antes da API.** Quando a migration sai do PR da API, a decisão estrutural vai junto quando a migration é estrutural (o gate exige), e a ordem de merge é migration antes da API: código que lê o retorno novo de uma função falha se vier o tipo antigo (#406, #530).
61. **Releitura depois da última espera.** Ler o estado do pai "depois das travas" só fecha a janela se a leitura vier depois da última espera antes da escrita. Num `UPDATE` sem policy de cliente ativo, quem fecha o resto é o gatilho do banco. Complementa o item 30 (#541).
62. **Gatilho com erro em UPDATE de rota existente.** Gatilho novo que levanta erro num `UPDATE` já usado por rota existente exige achar e testar cada rota que faz esse `UPDATE` antes do merge: a revisão do #545 achou, antes do merge, que o gatilho novo faria o `PATCH` de persona dar 500 (#545).
63. **Lista de colunas do gatilho contra o grant.** Lista de colunas escrita à mão num gatilho precisa de teste de catálogo contra o grant (`tgattr` x `has_column_privilege`); senão coluna gravável nova escapa sem vermelho. Complementa o item 33 (#538).
67. **Corrida com trava segurada.** Na trava de linha (tuple lock), o 2º waiter é bloqueado pelo 1º waiter, não pelo holder: esperar N bloqueados pelo pid do holder trava; conte `cardinality(pg_blocking_pids) > 0` (#555). Na trava consultiva, o holder bloqueia os dois waiters, e a contagem pelo pid do holder vale.

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
47. **Tela acima do teto de diff.** Acima de ~800 linhas de diff de código, o PR se divide (decisão `2026-10-07-pr-agrupado-por-tema`); numa tela com abas, a divisão natural é por aba.

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

As lições completas de segurança estão em `docs/security-review.md` e nas notas do projeto; este checklist só lista o que mais se repete.
