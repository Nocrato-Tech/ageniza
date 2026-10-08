# Checklist do implementador

Passe por este checklist antes de abrir ou atualizar um PR. Cada item nasceu de um
achado real de revisão ou de uma regra de ambiente; o teste que continua verde sem a
regra é o erro mais repetido.

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
12. **Decisão no mesmo PR.** Regra de negócio nova vira um arquivo novo em `docs/business/decisions/` no mesmo PR (#282).
13. **Pasta e banco próprios.** Agente em paralelo usa a própria pasta e o próprio banco `ageniza_<id>`; o banco `ageniza` é o do ambiente local do dono.
14. **Borda com filtro.** Paginação além do fim e recontagem testadas com e sem busca: busca com resultado e `page` além do fim responde o total filtrado (#415).
15. **Lista truncada.** Quando a tela lê só os N primeiros, um teste passa do limite (51 comentários, 101 conversas) e confere que o mais recente e a resposta nova aparecem (#413).
16. **Estados da tela.** Carregando, erro e vazio têm teste com asserção do texto; Esc num modal dentro de outro fecha só o de cima (#413).
17. **Timers e eventos no web.** Três testes: sobreposição (resposta segurada por uma promise, eventos repetidos, uma chamada só), vazamento (evento disparado depois de desmontar não chama nada) e ausência de sessão (nada roda) (#419).
18. **Efeito colateral numa transação.** Decida o efeito (ex.: revogar sessão) pelo que a transação escreveu, nunca por uma leitura sem trava anterior. O teste de atomicidade injeta uma falha DEPOIS da escrita (trigger que faz o passo seguinte falhar) e confere que nada ficou (#417).
19. **Guard reaproveitado.** Rota nova que reusa um guard com uma opção tem teste de cada regra do guard naquela rota (#417, #423).
20. **A decisão descreve o código de verdade.** Afirmação como "a tela já faz X" ou "a decisão Y diz Z" é conferida no código e no texto citado antes de registrar; depois do merge o arquivo não se edita (#414, #420).
21. **API e tela em PRs separados.** Mesmo quando a issue pede as duas (#417, #419).
22. **Harness no banco certo.** Antes de rodar a integração, confira que `DATABASE_URL` e `MIGRATION_DATABASE_URL` apontam para o seu banco; se faltarem, o harness cai no `ageniza` (#391, #426).

As lições completas de segurança estão em `docs/security-review.md` e nas notas do projeto; este checklist só lista o que mais se repete.
