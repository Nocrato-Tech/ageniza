# Entrar com o Google, as telas

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 e a de 2026-10-27 (o que a implementação teve de decidir) fixam a regra e a API do login com o Google. Fazer as telas (issue #713) pediu escolhas de interface que elas não cobrem: quando o botão aparece, onde a pessoa bloqueada pelo aceite é interceptada, e como a conta só com Google chega à reautenticação sem que a tela saiba se a conta tem senha.

**Decisão.**

1. **O botão só existe quando o servidor diz que o Google está ligado.** `GET /auth/providers` com `google: true`; qualquer outra resposta, falha ou campo fora do contrato esconde o botão (e o "ou"). O caminho que a tela não deve oferecer é o que responderia 404.
2. **O Google existe na tela do convite e na entrada que carrega um convite** (decisão do dono de 2026-10-26: "Entrar com o Google" em `/entrar`, em `/criar-conta` e na tela do convite). O convite atravessa a ida ao Google no `sessionStorage` da aba (nunca no endereço enviado ao servidor: o link é só `/auth/google/start`), é validado e gasto uma vez na volta, e a pessoa volta a `/convite/<token>` com a marca de que entrou por esse convite, o caminho que o login por senha já usa. Quem aceita é a tela do convite, e só quando o e-mail da sessão é o do convite; com outro e-mail aparece o erro que o convite já mostra ("Você está conectado com outra conta…") e nada é aceito nem vinculado. Convite vencido ou revogado durante a ida cai em "Este convite não é mais válido". Cada partida para o Google guarda o convite da tela ou apaga o que uma tentativa abandonada deixou, para que ele não acompanhe uma entrada que não é a dele. Um botão a menos só para quem já está conectado.
3. **O aceite é interceptado em `/comecar`, não em `/contextos`.** A API devolve contextos vazios enquanto o aceite é exigido, então o resolve responde `none` e a pessoa cai em `/comecar`; é ali que a tela consulta `required` e manda para `/aceite`. O seletor de contextos continua sem ler os aceites (há teste que o exige). O aceite pedido é uma caixa só, e os documentos são gravados um a um.
4. **A tela não sabe se a conta tem senha.** A sessão não traz essa informação, então o diálogo de troca de e-mail mantém o campo de senha e, com o Google ligado, oferece "Não tenho senha, entro com o Google". Escolhida a opção, o pedido vai sem senha; `REAUTH_REQUIRED` leva ao Google, e a resposta de que a conta tem senha (400 `VALIDATION_ERROR`) devolve o campo.
5. **A volta da reautenticação só segue endereço do próprio aplicativo.** O endereço de onde a pessoa saiu fica no `sessionStorage`; só caminho que começa com uma barra, sem `//` e sem barra invertida, é seguido, e o resto cai em `/contextos`. O diálogo reabre já no modo Google por uma marca no estado da navegação, gasta na chegada.
6. **A frase da recusa é a da senha errada.** `/entrar?erro=google` mostra `E-mail ou senha incorretos.`, que é o que a tela de senha já diz, e não repete a frase ao lado de uma falha de senha.
7. **Uma rota de agência ou de portal recusada pelo aceite leva ao `/aceite` e volta.** A conta bloqueada que abre `/agencia/:id` ou `/portal/:id` direto (favorito, link de notificação, convite aceito) recebe `403 TERMS_NOT_ACCEPTED` das guardas; a tela manda para `/aceite` levando o endereço pedido no estado da navegação, e depois do aceite volta a ele. Só endereço do próprio aplicativo é seguido (a mesma regra do item 5); sem endereço, segue pela entrada. Qualquer outro 403 continua na tela de falha.

**Consequência.** Só interface: nenhuma rota, coluna ou regra de negócio muda, e a API da #733 é usada como está. Efeitos aceitos: a pessoa que tem Google e senha vê o atalho "Não tenho senha" e precisa voltar ao campo se escolher errado; o e-mail novo digitado não sobrevive ao desvio pelo Google; uma conta sem senha e sem Google ligado não tem como pedir a troca de e-mail pela tela. Um campo `hasPassword` na sessão tiraria o atalho e o desvio.

**Origem.** Decisões tomadas pelo implementador da issue #713 ao aplicar as decisões de 2026-10-26 e 2026-10-27, com o maestro como intermediário do dono.

**Validação.** Pendente de validação do dono.
