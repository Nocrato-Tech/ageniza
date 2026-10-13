# O CPF do cadastro só é guardado como HMAC

**Data.** 2026-10-13

**Contexto.** O CPF de quem se cadastra serve só para o "um teste por CPF", e para isso basta um identificador que permita comparar.

**Decisão.** O CPF nunca é guardado em claro. Ele chega por conexão segura, é processado só no backend, tem o dígito verificador validado e é normalizado antes de virar HMAC. A chave do HMAC fica fora do banco, com acesso restrito e plano de rotação; a rotação guarda as chaves anteriores para que um teste antigo continue sendo reconhecido. Logs, telemetria, mensagens de erro e rastreamento nunca registram o CPF em claro.

**Consequência.** O CPF continua sendo dado pessoal tratado pelo sistema, e o HMAC é dado pseudonimizado (ainda liga cadastros entre si), com finalidade e retenção definidas na política de privacidade.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
