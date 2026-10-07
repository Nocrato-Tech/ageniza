# Carregamento tem três tratamentos, e escrita nunca deixa dado velho na tela
**Data.** 2026-09-24

**Contexto.** `apps/web/src/query.ts` usa `staleTime` de 30s, sem refazer busca ao focar a janela ou reconectar. Isso significa que voltar a uma tela em menos de meio minuto serve o cache: navegação não é o que atualiza a tela depois de uma escrita, ao contrário do que a intuição sugere. Sem uma convenção escrita, a primeira tela decidiria isso sozinha.

**Decisão.** Carregamento tem três situações e tratamentos distintos: **primeira carga** usa skeleton com a forma do conteúdo, que reserva o layout; **revalidação com dado em tela** não muda a tela; **ação pontual** mantém o estado no próprio controle, com confirmação ao terminar e sem travar o fluxo. **Não existe spinner de tela cheia depois da primeira carga.**

E a regra que governa atualização: **toda mutação invalida as queries que afeta**, declaradas na SPEC do módulo. Salvar e continuar exibindo o dado anterior é defeito, não latência. Sem tempo real e sem polling.

**Consequência.** `staleTime` deixa de governar a atualização e vira apenas economia de requisição. Toda SPEC de módulo passa a declarar, por rota de escrita, quais listagens ela invalida — sem isso a regra não é verificável.

**Origem.** Decidido em sessão (sessão 0 de autorização e transversais).

