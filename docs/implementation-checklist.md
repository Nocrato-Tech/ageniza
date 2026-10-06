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
12. **Decisão no mesmo PR.** Regra de negócio nova vai para `docs/business/decisions.md` no mesmo PR, com linha em branco antes do `---` (#282).
13. **Pasta e banco próprios.** Agente em paralelo usa a própria pasta e o próprio banco `ageniza_<id>`; o banco `ageniza` é o do ambiente local do dono.

As lições completas de segurança estão em `docs/security-review.md` e nas notas do projeto; este checklist só lista o que mais se repete.
