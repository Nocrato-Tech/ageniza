# Arquivado fica fora da listagem até ser pedido
**Data.** 2026-09-24

**Contexto.** Com `archived` definido como estado terminal reversível de entidade de negócio, faltava dizer se ele aparece nas listagens.

**Decisão.** Entidade arquivada **não aparece** na listagem padrão. Ela é devolvida apenas quando a requisição pedir explicitamente, pelo parâmetro nomeado de status da rota.

**Consequência.** Arquivar passa a significar algo na tela, e não apenas um rótulo. Toda listagem de entidade que tenha `archived` precisa declarar na SPEC o parâmetro que revela o arquivado.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

