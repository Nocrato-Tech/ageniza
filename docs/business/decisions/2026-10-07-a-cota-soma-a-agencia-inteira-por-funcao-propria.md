# A cota de armazenamento soma a agência inteira por uma função própria

**Data.** 2026-10-07

**Contexto.** `readQuotaSnapshot` somava `media_assets` por um `select` comum, sob a RLS de quem chama. Desde a #247 a mídia de cliente se lê com `conteudo.visualizar`, e quem só tem `midia.enviar` não a enxerga: a soma ficaria curta e a agência passaria da cota ([`2026-10-07-conteudo-pastas-de-midia-e-midia-com-cliente-no-banco.md`](2026-10-07-conteudo-pastas-de-midia-e-midia-com-cliente-no-banco.md), consequência 1; pendência registrada na revisão do PR #376). A SPEC fala da cota só na infraestrutura de mídia e não diz o que fazer com a mídia removida.

**Decisão.**
1. A soma vem de `app_private.agency_media_usage(agência, janela_em_segundos, mídia_excluída)`, `security definer`, que soma **toda** a mídia da agência (com e sem cliente), sem depender da RLS de quem chama. Conta a confirmada e a pendente dentro da janela de reserva, como o `select` que substitui.
2. A função confere dentro que quem chama pode enviar: `midia.enviar` **ou** `conteudo.operar` na agência. Sem nenhuma das duas, `42501`. Janela nula ou negativa dá `22023`, porque uma janela nula descartaria em silêncio todas as reservas pendentes.
3. **Mídia removida continua contando** na cota até o fluxo de retenção apagar o arquivo: a remoção é lógica (`removed_at`) e o objeto segue no armazenamento. Liberar a cota na remoção deixaria a agência ocupar espaço que não conta.

**Consequência.**
- A rota de upload de Conteúdo (#253) passa a ler o uso por esta função; a leitura direta de `media_assets` na cota sai.
- Quem remove muita mídia não ganha cota de volta até a retenção existir. Se isso incomodar, a mudança é uma linha na função e uma decisão nova.
- Não é estrutural: só cria uma função.

**Origem.** Issue #253 (requisito vindo da revisão do PR #376, #247 e #371) e decisão do maestro de 2026-10-07 de que a soma por função entra antes da rota de upload.

**Validação.** Pendente de validação do dono.
