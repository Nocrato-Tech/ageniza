# CHECK no cargo do vínculo, com backfill pequeno e explícito

**Data.** 2026-10-01

**Contexto.** `agency_memberships.job_title` é `text` sem restrição, enquanto o schema de resposta da listagem (#95), do detalhe (#96) e da rota de cargos (#218) exige um valor aparado de 1 a **256 unidades UTF-16**, contando como whitespace de borda o conjunto do `String.prototype.trim` do JavaScript (que inclui NBSP **e** U+FEFF, entre outros). Um único cargo fora desse formato derruba com **500** a leitura da agência inteira. Hoje só o `seed:demo` grava cargo; a #97 vai passar a gravar. Achado da revisão do PR #220 e da revisão do PR #232.

**Decisão.** Mudança **estrutural, de backfill pequeno**, na migration `20261001000000_job_title_format`: a forma armazenada passa a ser o valor aparado pelas mesmas regras do contrato (trigger `BEFORE INSERT OR UPDATE` chama `app_private.normalize_job_title`), e o `CHECK` exige 1 a 256 **unidades UTF-16** (`app_private.utf16_length`), não pontos de código. Antes do `CHECK`, o backfill trata o legado: espaços-só viram `null` e um legado que ainda passe de 256 unidades UTF-16 também vira `null`; o `up()` da migration imprime as três contagens em uma linha (`console.log`, visível no log do `pnpm db:migrate`), porque um `raise notice` não chega a log nenhum sob o `log_min_messages` padrão do servidor — **não há truncamento silencioso**. `specs/colaboradores.md` não muda de formato. Alcance: uma tabela, uma coluna.

**Consequência.** O dado lido nunca é inválido para o contrato, em nenhuma rota presente ou futura. O preço é a perda explícita do legado acima de 256, registrada e contada. **Pendente de validação** do dono do produto: a escolha de descartar (em vez de truncar) um cargo legado acima do limite.

**Origem.** Issue #225, achados da revisão do PR #220 (#218) e da revisão do PR #232. **Pendente de validação** do dono do produto.

