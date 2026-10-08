# A carteira de clientes ordena pelo nome dobrado comparado byte a byte, e não pelo collation do banco

**Data.** 2026-10-08

**Contexto.** A carteira (#125, PR #291) ordena por nome ascendente "sem diferenciar maiúsculas nem acento", e para isso dobra o texto na consulta (`foldTextSql`). Dobrar tira acento e caixa, mas a comparação do texto dobrado continuava no collation do banco, que decide a posição de espaço, hífen e dígito, e o banco de produção não fixa collation no repositório. Medido com a mesma expressão: em `en_US.utf8` a ordem é `Ana2 | Ana Beatriz | Anabela | Anaïs | Ana-Lúcia | Ana Maria | Ana Zélia`; em `collate "C"`, `Ana Beatriz | Ana Maria | Ana Zélia | Ana-Lúcia | Ana2 | Anabela | Anaïs`. Os testes antigos usavam nomes de uma palavra, então a garantia que as entradas anteriores descreviam ("a ordem não depende do collation") não era verdadeira para nome de várias palavras. A lista de colaboradores já resolveu o mesmo problema (`2026-10-07-a-lista-de-colaboradores-ordena-por-nome-dobrado-sem-acento.md`) e deixou a carteira para uma issue própria, a #367.

**Decisão.** A carteira ordena por `foldTextSql(nome) collate "C"` ascendente, com o desempate de antes (`id`), nos dois `sort` (`attention`, depois da triagem, e `name:asc`). É a mesma regra da lista de colaboradores: o texto dobrado comparado byte a byte, determinístico em qualquer banco. `Ágata Costa`, `Ana Beatriz`, `Ana Maria`, `Ana Zélia`, `Ana-Lúcia`, `Ana2`, `Anabela`, `Anaïs`, `Beatriz Álvares`, `Édson` e `Eduardo` saem nessa ordem em qualquer banco. Nomes que dobram para o mesmo texto ficam na ordem do `id`.

**Consequência.** A garantia real da entrada anterior da carteira passa a ser esta: acento, caixa, espaço, hífen e dígito ordenam do mesmo jeito em qualquer banco. Muda apenas a ordem de exibição de nomes de várias palavras, com hífen ou com dígito, inclusive entre páginas; busca, filtros, o formato da resposta e a regra de triagem não mudam. Ordenar pelo nome cru, dobrar sem `collate "C"` ou comparar pelo collation do banco reabre esta decisão.

**Origem.** Issue #367 (achado da revisão do PR #366, #355), pedida pelo maestro em 2026-10-08.

**Validação.** Pendente de validação do dono.
