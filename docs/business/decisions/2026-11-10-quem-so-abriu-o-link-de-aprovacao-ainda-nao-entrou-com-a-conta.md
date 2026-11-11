# Quem só abriu o link de aprovação ainda não entrou com a conta

**Data.** 2026-11-10

**Contexto.** A decisão [`2026-11-10-estrutural-ultimo-acesso-ao-portal-por-cliente`](2026-11-10-estrutural-ultimo-acesso-ao-portal-por-cliente.md) manda gravar o último acesso também quando a pessoa usa o link de aprovação do e-mail. Esse link não exige conta. A revisão de segurança da onda 2 achou a pergunta que a decisão deixou aberta: a pessoa que só abriu o link "entrou"? A resposta decide o botão "Reenviar boas-vindas", que só aparece para quem ainda não entrou.

**Decisão.**

1. **"Entrou" continua sendo entrar com a conta.** A pessoa só "entrou" quando uma conta entrou no portal daquele cliente (a primeira entrada). Abrir o link de aprovação não muda isso.
2. **O último acesso pode existir sem a primeira entrada.** Quem só abriu o link tem o último acesso preenchido e continua "ainda não entrou". Quem nunca entrou nem abriu o link continua "nunca entrou".
3. **O reenvio das boas-vindas não muda.** Ele segue permitido para quem ainda não entrou com a conta, tenha ou não aberto o link.
4. **O que a agência vê.** Na lista de pessoas do portal, quem só abriu o link aparece como "Ainda não entrou com a conta · abriu o link em <data>". Quem entrou com a conta aparece com o último acesso, e quem nunca entrou nem abriu o link, como "nunca entrou".
5. **O nome continua vindo da conta.** O nome da pessoa só aparece depois que a conta entrou, como antes: abrir o link não revela se o endereço tem conta.

**Consequência.**

- A regra do contrato que dizia que o último acesso é sempre vazio enquanto a pessoa não entrou deixa de valer. O campo é uma data ou vazio, em qualquer situação.
- As telas da agência (web e celular) mostram os dois casos com as palavras acima, e não escondem o reenvio de quem só abriu o link.
- Não há dado novo nem mudança de tabela: é a leitura do que o banco já grava.

**Origem.** O maestro, a partir da revisão de segurança da onda 2 do escopo `telas-melhorias`.

**Validação.** Pendente de validação do dono.
