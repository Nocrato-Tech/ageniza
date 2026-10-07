# Limite de tamanho do nome no perfil próprio

**Data.** 2026-09-30

**Contexto.** A SPEC de colaboradores (`specs/colaboradores.md`, §§3, 5 e 6) exige que o nome do próprio perfil seja obrigatório, não vazio e com **limite de tamanho**, mas não fixa um número. A task #101 precisava de um valor para validar `PATCH /me/profile`.

**Decisão.** O nome é aparado (trim) e aceito entre 1 e **120** caracteres. Nome vazio, só com espaços, tabulação ou NBSP é recusado. O e-mail não é editável por nenhuma rota do módulo de perfil.

**Consequência.** 120 é folgado para um nome de exibição e não colide com nada existente. Se o dono do produto quiser outro número, é mudança de uma constante em `packages/contracts/src/profile.ts` e do teste correspondente — sem migration nem mudança de formato.

**Origem.** Task #101. **Pendente de validação** — o número foi escolhido na implementação porque a SPEC não o define.

