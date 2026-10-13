# Matriz de autorização da assinatura

**Data.** 2026-10-13

**Contexto.** Owner, Admin, demais membros, portal do cliente, operação e provedor de pagamento agem sobre a assinatura de formas diferentes.

**Decisão.**

| ação | Owner | Admin | demais | portal | operação (CLI) | provedor (webhook) |
|---|---|---|---|---|---|---|
| ver plano, uso, limites, adicionais e histórico de cobrança | sim | só leitura (`assinatura.visualizar`, preset Admin), dado financeiro limitado ao necessário | só a mensagem do limite | não | sim | não |
| escolher plano e pagar | sim | não | não | não | não | não |
| comprar ou remover adicional | sim | não | não | não | não | não |
| trocar de plano, cancelar, desfazer o cancelamento | sim | não | não | não | só exceção autorizada, com motivo | não |
| pedir exclusão da agência | sim | não | não | não | sim, pelo fluxo de exclusão, com motivo e confirmação | não |
| confirmar pagamento ou falha | não | não | não | não | não | só evento autenticado e conferido |
| suspender ou reativar administrativamente | não | não | não | não | sim, com motivo | não |
| isentar e tirar a isenção | não | não | não | não | sim, com motivo | não |
| criar agência própria | qualquer conta com e-mail confirmado; o teste só se ainda tiver direito, concedido de forma atômica | | | | sim, sem teste | não |

As ações do Owner seguem o caminho do dono, não uma permissão: não se delegam e nenhum papel personalizado futuro as recebe. A operação nunca simula o consentimento do Owner. O webhook só processa evento autenticado, conferido contra o provedor e contra a agência e a cobrança dele; um webhook válido não autoriza qualquer transição. Ele muda estado por uma função `security definer` de escopo único e auditada, nunca por uma identidade de acesso amplo. A exclusão pela operação segue o mesmo fluxo, prazo e avisos, e não é um atalho.

**Consequência.** Permissão nova `assinatura.visualizar` no catálogo e no preset do Admin.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
