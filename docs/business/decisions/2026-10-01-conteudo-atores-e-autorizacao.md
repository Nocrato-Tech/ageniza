# Conteúdo: atores e autorização

**Data.** 2026-10-01

**Contexto.** Bloco 2 da entrevista de Conteúdo. Diferente de Clientes, Produção é quem produz o conteúdo.

**Decisão.**
- Permissões e presets:

| permissão | o que libera | Admin | Gestor de conta | Produção | Vendas | Financeiro |
|---|---|---|---|---|---|---|
| `conteudo.visualizar` | ver calendário, conteúdos, comentários, subtarefas e roteiros de stories | ✓ | ✓ | ✓ | | |
| `conteudo.operar` | criar, editar, mover de data, anexar mídia, comentar, criar subtarefas, enviar para aprovação, roteirizar stories | ✓ | ✓ | ✓ | | |
| `conteudo.publicar` | marcar como publicado | ✓ | ✓ | ✓ | | |
| `conteudo.aprovar_pela_agencia` | registrar "aprovado fora da plataforma" | ✓ | ✓ | | | |
| `conteudo.cancelar` | cancelar um conteúdo, que fica guardado | ✓ | ✓ | | | |

- **Vendas e Financeiro não veem Conteúdo.**
- **Subtarefa** é aprovada pelo **responsável do conteúdo**; Admin e Gestor de conta podem substituí-lo.
- **No portal**, qualquer pessoa ativa daquele cliente aprova ou pede ajuste, e uma basta; fica registrado quem.
- **Em produção, o portal vê só título, data e tipo**; legenda e mídia aparecem a partir de "aguardando aprovação".
- **Aprovado fora da plataforma** vale sempre, com a permissão e um **motivo obrigatório**, e aparece no portal como aprovado pela agência.
- Quem tem `conteudo.visualizar` vê o conteúdo de **todos** os clientes da agência, como em Clientes; restringir por atribuição segue o gatilho já registrado.
- **Stories entram no MVP na forma mínima**: a agência cria o roteiro de stories de uma data (sequência de cenas com texto e orientação); o cliente vê no portal e marca **gravado**. Sem mídia, sem aprovação, fora da grade do feed.

**Consequência.** É o primeiro módulo em que `visualizar` não vale para os cinco presets. O que Clientes mostra derivado de conteúdo (aba Conteúdos, indicadores do card, ordem por atraso) precisa respeitar isso para quem não tem `conteudo.visualizar`.

**Origem.** Decidido pelo dono do produto em sessão (entrevista do módulo Conteúdo), em 2026-10-01.

