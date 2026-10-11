# O nome de pasta de mídia recusa os caracteres invisíveis e aceita o seletor de emoji depois de um pictograma

**Data.** 2026-10-11

**Contexto.** A regra de nome de exibição recusa só os caracteres da categoria `Cf`. Num nome de pasta de mídia (`MediaFolderNameSchema`), `Imagens` mais U+034F (CGJ, categoria `Mn`), um seletor de variação, um seletor mongol, uma vogal inerente khmer ou o braille em branco U+2800 (categoria `So`, que se desenha como espaço) passava, e a pasta ficava com a aparência de uma pasta padrão que já existe. A revisão de segurança do PR #406 apontou o caso (issue #531, Baixa 4). A decisão de 2026-10-08 sobre o nome do cliente ([`2026-10-08-invisiveis-recusados-no-nome-do-cliente`](./2026-10-08-invisiveis-recusados-no-nome-do-cliente.md)) já fechou a mesma classe para o cliente, mas recusa emoji por completo; a pasta aceita emoji (a pasta `Pasta ✨ com emoji` é aceita hoje), e um emoji como "❤️" é U+2764 seguido de U+FE0F.

**Decisão.** O nome da pasta recusa todo `Default_Ignorable_Code_Point` do Unicode e U+2800, no começo, no meio e no fim. Uma exceção: U+FE0F é aceito logo depois de um caractere pictográfico (`Extended_Pictographic`), uma vez. U+FE0F depois de qualquer outra coisa, um segundo seletor depois do primeiro e os demais seletores de variação (incluindo U+FE0E) continuam recusados. Os dois joiners (U+200C e U+200D), que o schema já recusava na pasta, ficam cobertos pela mesma regra. `createDisplayNameSchema`, o nome do cliente e os nomes de pessoas não mudam.

**Consequência.** O `POST` de pasta responde `400` para esses nomes. Pastas já gravadas não são corrigidas (sem backfill, sem migration). O banco continua sem restrição de caractere no nome da pasta: a regra é do schema, como a do nome do cliente. Confusáveis de outra natureza (cirílico, largura total) seguem fora do escopo.

**Origem.** Issue #531, item 2, revisão de segurança do PR #406. O seletor de emoji é uma escolha de quem implementou, tomada para não recusar o emoji que a pasta aceita hoje, na mesma linha da exceção da primeira versão da decisão do cliente.

**Validação.** Pendente de validação do dono.
