# Infraestrutura cresce por necessidade, com mudança estrutural tratada à parte
**Data.** 2026-09-23

**Contexto.** A base está madura e o molde de módulo novo está pronto, então antecipar infraestrutura resolveria problemas que talvez nunca apareçam. Ao mesmo tempo, aqui nem toda mudança é local: migration aplicada não se edita, RLS existe em toda tabela de negócio, e o primeiro módulo a resolver um problema vira o modelo que os próximos copiam.

**Decisão.** Infraestrutura é incrementada conforme a regra de negócio exigir. Mudança **estrutural** — que altera tabelas existentes, muda um formato que outras rotas copiam, atravessa RLS de vários módulos, muda como a autorização é avaliada, ou exigiria backfill — para antes de ser implementada e é registrada aqui primeiro.

**Consequência.** `AGENTS.md` obriga a leitura de [structural-changes.md](structural-changes.md) antes de qualquer implementação nova, e esse arquivo mantém a lista viva do que já sabemos ser estrutural. O custo é uma parada explícita quando o caso aparece; o que se evita é decidir em silêncio dentro de um PR que era sobre outra coisa.

**Origem.** Decidido em sessão.

