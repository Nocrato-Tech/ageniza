# Checklist do implementador

Passe por este checklist antes de abrir ou atualizar um PR. Cada item nasceu de um
achado real de revisão; o teste que continua verde sem a regra é o erro mais repetido.

1. **Automutação obrigatória.** Para cada regra e cada item de aceite, apague ou inverta a linha que o implementa, rode o teste, veja ficar vermelho, reponha; liste no corpo do PR a mutação que prova cada aceite (#282, #291, #293, #298, #300).
2. **Isolamento.** Monte o cenário com uma situação em que a RLS **mostra** a linha (pessoa com vínculo em duas agências); senão a RLS esconde a falta do filtro (#186, #293). Escrita em recurso alheio confere o estado no banco, não só o status 404 (#282).
3. **Autorização.** Teste com papel personalizado de uma permissão só, e com o dono sem papel atribuído (`owner_user_id`) (#291, #298).
4. **Typecheck depois do develop.** Ao trazer o develop, rode `pnpm typecheck` mesmo sem conflito: mudança de contrato mescla limpo e quebra em runtime (`parseRequest`/`parseResponse` viraram `routeQuery`/`routeBody`/`routeResponse` na #209; `set_config('app.user_id')` virou `app_private.bind_actor` na #201) (#282, #291, #294).
5. **Valor por valor.** O teste fixa o esperado por valor; nunca itera a própria constante que deveria verificar (#300).
6. **"X não acontece" é checado.** Aceite do tipo "não acontece" (ex.: pacote fora da imagem) precisa de checagem automatizada que falhe (#300).
7. **Cada catch de banco tem teste.** `42501`, `23505`, `40P01` — teste provoca o erro e confere o 4xx e a linha intacta (#282).
8. **Listagem.** Desempate de ordenação, busca mínima (ex.: `@` sozinho) e contagem e página no mesmo snapshot com `count(*) over ()` (#291, #298).
9. **Decisão no mesmo PR.** Regra de negócio nova vai para `docs/business/decisions.md` no mesmo PR, com linha em branco antes do `---` (#282).
10. **Pasta e banco próprios.** Só a sua pasta e o seu banco; nunca o checkout de outro agente, nunca o banco `ageniza`.

As lições completas de segurança estão em `docs/security-review.md` e nas notas do projeto; este checklist só lista o que mais se repete.