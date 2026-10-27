# Entrar com o Google, as telas

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 e a de 2026-10-27 (o que a implementação teve de decidir) fixam a regra e a API do login com o Google. Fazer as telas (issue #713) pediu escolhas de interface que elas não cobrem: quando o botão aparece, onde a pessoa bloqueada pelo aceite é interceptada, e como a conta só com Google chega à reautenticação sem que a tela saiba se a conta tem senha.

**Decisão.**

1. **O botão só existe quando o servidor diz que o Google está ligado.** `GET /auth/providers` com `google: true`; qualquer outra resposta, falha ou campo fora do contrato esconde o botão (e o "ou"). O caminho que a tela não deve oferecer é o que responderia 404.
2. **A entrada com convite não oferece o Google.** O convite viaja no estado da navegação até o `POST /auth/login`; o Google não tem como levá-lo, então o botão não aparece nessa entrada. Quem aceita um convite por e-mail entra com senha, como antes.
3. **O aceite é interceptado em `/comecar`, não em `/contextos`.** A API devolve contextos vazios enquanto o aceite é exigido, então o resolve responde `none` e a pessoa cai em `/comecar`; é ali que a tela consulta `required` e manda para `/aceite`. O seletor de contextos continua sem ler os aceites (há teste que o exige). O aceite pedido é uma caixa só, e os documentos são gravados um a um.
4. **A tela não sabe se a conta tem senha.** A sessão não traz essa informação, então o diálogo de troca de e-mail mantém o campo de senha e, com o Google ligado, oferece "Não tenho senha, entro com o Google". Escolhida a opção, o pedido vai sem senha; `REAUTH_REQUIRED` leva ao Google, e a resposta de que a conta tem senha (400 `VALIDATION_ERROR`) devolve o campo.
5. **A volta da reautenticação só segue endereço do próprio aplicativo.** O endereço de onde a pessoa saiu fica no `sessionStorage`; só caminho que começa com uma barra, sem `//` e sem barra invertida, é seguido, e o resto cai em `/contextos`. O diálogo reabre já no modo Google por uma marca no estado da navegação, gasta na chegada.
6. **A frase da recusa é a da senha errada.** `/entrar?erro=google` mostra `E-mail ou senha incorretos.`, que é o que a tela de senha já diz, e não repete a frase ao lado de uma falha de senha.

**Consequência.** Só interface: nenhuma rota, coluna ou regra de negócio muda, e a API da #733 é usada como está. Efeitos aceitos: a pessoa que tem Google e senha vê o atalho "Não tenho senha" e precisa voltar ao campo se escolher errado; o e-mail novo digitado não sobrevive ao desvio pelo Google; uma conta sem senha e sem Google ligado não tem como pedir a troca de e-mail pela tela. Um campo `hasPassword` na sessão tiraria o atalho e o desvio.

**Origem.** Decisões tomadas pelo implementador da issue #713 ao aplicar as decisões de 2026-10-26 e 2026-10-27, com o maestro como intermediário do dono.

**Validação.** Pendente de validação do dono.
