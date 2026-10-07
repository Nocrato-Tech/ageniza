# Criar e reenviar convite travam na mesma ordem, e o deadlock vira 409 TRY_AGAIN

**Data.** 2026-10-07

**Contexto.** A revisão de segurança do PR #330 (#304) observou, num defeito que já existia, que criar convite trava o slot dos convites equivalentes e depois a linha, e reenviar trava a linha e depois o slot. Com o mesmo destinatário ao mesmo tempo, o resultado era deadlock (`40P01`), que não era traduzido e virava `500`. Sem impacto de segurança, porque nada é gravado. Issue #335. Registrada aqui depois do código, porque a issue não gerou entrada.

**Decisão.**

1. Criar e reenviar travam **na mesma ordem**: o slot antes da linha do convite, também no reenvio. A regra da #304 se mantém: a pendência só é decidida depois da última trava.
2. `40P01` e `40001` nas rotas de escrita de convite viram `409 TRY_AGAIN`, sem detalhe do banco, como já valia para a troca de e-mail (#325).

**Consequência.** Só código da API e o OpenAPI: nenhuma tabela, policy, permissão ou migration muda, e nenhum fluxo legítimo muda. Vale a lição já registrada: função que trava mais de uma linha trava sempre na mesma ordem, em todos os caminhos.

**Origem.** Issue #335, decisão do maestro. Entrada acrescentada na #358.

