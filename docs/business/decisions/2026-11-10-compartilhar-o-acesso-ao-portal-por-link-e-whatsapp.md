# A agência compartilha o endereço de entrada do portal por "Copiar link" e "Enviar pelo WhatsApp"

**Data.** 2026-11-10

**Contexto.** Depois de dar acesso a uma pessoa do cliente, a agência quer avisá-la por onde já conversa com ela, sem depender só do e-mail.

**Decisão.**

1. Na lista de pessoas do portal, "Copiar link" e "Enviar pelo WhatsApp" compartilham o endereço de entrada do portal (`/entrar`), com uma **mensagem pronta em nome da agência**.
2. O endereço **não tem token e não dá acesso sozinho**: quem o recebe ainda entra pelo próprio e-mail, como hoje.

**Consequência.**

- Só a tela muda: nenhuma rota, tabela ou permissão. Não envolve segredo, ao contrário do link de convite de colaborador (decisão [`2026-10-26-estrutural-o-link-do-convite-de-colaborador-pode-ser-copiado`](2026-10-26-estrutural-o-link-do-convite-de-colaborador-pode-ser-copiado.md)).

**Origem.** Pedido do dono do produto em 2026-11-10, depois da pesquisa da Orkestrya e do Refcat (2026-11-09).

**Validação.** Validada pelo dono em 2026-11-12.
