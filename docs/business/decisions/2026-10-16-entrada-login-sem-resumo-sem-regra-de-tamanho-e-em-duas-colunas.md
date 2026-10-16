# A entrada: login sem resumo de erros e sem regra de tamanho de senha, 404 sem área volta ao login, tela em duas colunas

**Data.** 2026-10-16

**Contexto.** No teste manual do dono, a tela `/entrar` apareceu "grande demais" e com três comportamentos que não servem a quem entra: o resumo "Corrija 2 campos: E-mail, Senha." acima de um formulário de dois campos; a frase "A senha tem no mínimo 10 caracteres." para quem digita a senha errada (a regra de 10 é de quem **cria** uma senha, no convite e na redefinição, e a API recusava com 400 qualquer senha curta no login, o que não é "e-mail ou senha incorretos"); e o "Voltar ao início" da página não encontrada levando quem não tem sessão à página pública `/`, que não é um começo para essa pessoa.

**Decisão.**
1. **Login sem resumo de erros.** Exceção à decisão de 2026-10-15 (erro de campo sem alerta, resumo único e foco no primeiro inválido), que continua valendo nas demais telas: em `/entrar` não há o resumo "Corrija N campos". Fica o erro de cada campo, ligado a ele por `aria-describedby`, e o foco no primeiro campo inválido. Com dois campos, a posição de cada mensagem já diz de que campo ela é.
2. **O login valida só que a senha não está vazia.** Senha vazia: "Informe a sua senha." Qualquer outra senha, de qualquer tamanho até 128 caracteres, vai ao servidor, que responde 401 e a tela mostra "E-mail ou senha incorretos." O contrato da API passa a ter um schema próprio para a senha apresentada no login (`AuthLoginPasswordSchema`, 1 a 128 caracteres); a regra de 10 a 128 (`AuthPasswordSchema`) continua só para criar a senha (convite e redefinição). O limite de tentativas do login é o mesmo de antes e passa a contar também as senhas curtas.
3. **404 sem área leva ao login.** Para quem não tem sessão, o "Voltar ao início" da página não encontrada leva a `/entrar`. Substitui o item 3 da decisão de 2026-10-10 ("sem sessão, o link segue para `/`"); os demais itens daquela decisão não mudam (com sessão, o início da área ou `/contextos`).
4. **Entrada em duas colunas no desktop.** Da largura de 64rem para cima, a entrada (login, esqueci a senha, redefinir, convite e confirmação de e-mail) tem à esquerda um painel de marca, encostado nas bordas da tela, com o mascote amigável centralizado sobre um tom da cor da marca (mistura do índigo com a superfície, sem token novo) e a frase "O mês de cada cliente numa pauta só."; à direita, o formulário centralizado na coluna, afastado da borda, na largura de 25rem. Abaixo de 64rem o painel some e o formulário ocupa a tela. Substitui o desenho da decisão de 2026-10-14 (entrada em uma coluna, com a semana de exemplo "Padaria Central" ao lado): a semana de exemplo sai, e os textos mantidos daquela decisão não mudam.

**Consequência.**
- Muda `packages/contracts` (um schema novo para a senha do login; o OpenAPI é regenerado) e o web; nenhuma migration, rota ou permissão nova.
- Sem a trava no cliente, a senha curta chega à API e passa pelo limite de tentativas como qualquer outra: o teste de integração prova o 401 e o 429.
- A SPEC `specs/auth.md` fixa a cópia do login e o layout.

**Origem.** Issue #700, teste manual do dono em 2026-10-16.

**Validação.** Pendente de validação do dono.
