# O nome no aceite do convite tem o limite do perfil: 120 caracteres

**Data.** 2026-10-08

**Contexto.** A decisão de [2026-09-30](2026-09-30-limite-de-tamanho-do-nome-no-aceite-de-convite.md) manteve 256 caracteres para o nome informado no aceite do convite, porque a SPEC não define o limite, e deixou aberta a pergunta de alinhar com os 120 do perfil. Na validação da #359 (linha 2) o dono respondeu: a pessoa conseguia entrar com um nome que depois não conseguia salvar no perfil.

**Decisão.**

1. **O nome do aceite do convite (`POST /invitations/:token/accept-new-account`) aceita até 120 caracteres**, o mesmo limite do nome do perfil, com a mesma constante (`DISPLAY_NAME_MAX_LENGTH`) e as mesmas regras de caractere (`DisplayNameSchema`). O aceite deixa de ter constante própria: `INVITATION_NAME_MAX_LENGTH` foi removida.
2. **Nome acima de 120 é `400 VALIDATION_ERROR`**, antes de o token ser consumido: o convite continua valendo para a pessoa corrigir o nome.
3. **Nomes já gravados com mais de 120 caracteres não são tocados.** Não há backfill, truncamento nem migration. Quem já entrou com um nome mais longo continua entrando, e o perfil só deixa de aceitá-lo ao ser salvo de novo (o problema que a decisão corrige para quem entrar daqui em diante). A consulta que dimensiona o resíduo é `select count(*) from auth."user" where char_length(name) > 120`; a verificação em produção fica com quem tem acesso a ela, e um resultado maior que zero é decisão nova, não correção silenciosa.

**Consequência.**

- Sem migration e sem mudança de formato de resposta; só o contrato de entrada do aceite fica mais estreito (`pnpm api:docs` muda o `maxLength` do campo).
- A tela de aceite mostra "Informe o seu nome." para qualquer erro de nome, inclusive o de tamanho; a mensagem própria é trabalho de interface, fora deste PR.
- Esta decisão **substitui** a de 2026-09-30, que não é editada: fica como histórico.

**Origem.** Issue #409; validação da #359 (linha 2).

**Validação.** Validada pelo dono em 2026-10-08.
