# Teto de página é global, tamanho é por rota, e bloco de resumo não pagina

**Data.** 2026-09-24

**Contexto.** A decisão de paginar por página não dizia tamanho nem ordem, e tratar isso como um número único não serve: o dashboard mostra quatro itens com um "ver mais", enquanto a listagem de clientes mostra dezenas. São dois papéis diferentes no mesmo parâmetro — um é segurança, o outro é interface.

**Decisão.** O **teto** de `pageSize` é global e vale **100** para toda rota, no contrato. O **tamanho padrão** é declarado por rota na SPEC do módulo, sem valor global. E **bloco de resumo não é listagem paginada**: usa `limit` fixo declarado na SPEC, sem `page` e sem `totalItems`, com link para a listagem completa.

**Consequência.** `pageSize=100000` deixa de ser um jeito barato de derrubar a API, e o dashboard não herda paginação que nunca vai exercitar. Rota que não declarar seu tamanho padrão na SPEC está incompleta.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

