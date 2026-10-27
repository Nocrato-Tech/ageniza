# Estrutural: toda troca de senha grava a data, e o login e a confirmação conferem a credencial de novo

**Data.** 2026-10-27

**Contexto.** A issue #719 (achado de segurança do PR #705, e da re-revisão do #722 para `POST /auth/email/verify`): um login com a senha antiga em corrida com a redefinição deixava uma sessão viva, porque `signInEmail` lê o hash, confere a senha (lento) e só depois grava a sessão, enquanto a redefinição troca a senha e apaga as sessões no meio. A issue propunha gravar `passwordChangedAt` e recusar no guarda toda sessão criada em ou antes dessa data (mecanismo que o #707 já aplicou à assunção pelo Google), ou conferir a credencial de novo depois de criar a sessão. Medido com o teste de corrida desta issue: a data sozinha **não** fecha a janela. A sessão do login atrasado nasce depois do commit da redefinição, com `createdAt` posterior à data, e o guarda a aceita (a corrida natural deixou sessão válida já na 1ª e na 2ª rodada). A data só pega a sessão cujo instante ficou antes da troca.

**Decisão.**
1. **Toda troca de hash da credencial grava `auth."user"."passwordChangedAt"` na mesma instrução**, por um gatilho `BEFORE UPDATE OF password` em `auth."account"` (só linhas `credential`, só quando o hash muda), com `clock_timestamp()` do banco. Cobre a redefinição de "Esqueci a senha", a troca de senha logado quando existir e qualquer outro escritor, sem cada um precisar lembrar. É `BEFORE` para travar a linha do usuário antes da da conta, a mesma ordem de `consume_email_confirmation`; um `AFTER` inverteria a ordem e poderia dar deadlock. A função é `security definer` porque a aplicação só lê a coluna.
2. `app_private.confirm_email_by_password_reset` (a assunção pela redefinição) grava a data por conta própria também: é o instante em que o titular anterior da conta não confirmada a perde.
3. O guarda de sessão continua recusando e apagando a sessão com `createdAt <= passwordChangedAt`.
4. **`POST /auth/login` e `POST /auth/email/verify` leem a credencial de novo depois que `signInEmail` criou a sessão** e a encerram, respondendo como credencial inválida, quando o hash já não é o que conferiram ou quando a leitura falha. Se o hash ainda é o mesmo, a troca ainda não apagou as sessões (ela troca o hash e só depois apaga), e a apagará junto com esta.
5. Os dois relógios: a data é do banco, o `createdAt` da sessão é o do Node (Better Auth), no mesmo host (ADR 0011). A comparação é `<=` e a resolução do Node (milissegundo) é a mais grossa; um relógio adiantado no banco só recusa sessões criadas logo depois da troca (a pessoa entra de novo), nunca aceita uma antiga.

**Consequência.** Estrutural, no banco: um gatilho em `auth."account"` (tabela que já existe) e a função de assunção redefinida, na migration `20261027120000`. Na API: a conferência depois do `signInEmail` nas duas rotas. Nenhum backfill: contas existentes ficam sem data até a próxima troca. Quem escrever outra rota que crie sessão a partir da senha repete a conferência (item 4); só a data não basta.

**Origem.** Issue #719, achado Média do PR #705 e da re-revisão do #722; decisão de 2026-10-27 sobre o Google (item 3), que deixou para esta issue gravar a data em toda troca de senha e fechar a corrida.

**Validação.** Pendente de validação do dono.
