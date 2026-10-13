# Cadastro público protegido contra robô e sem enumeração de conta

**Data.** 2026-10-13

**Contexto.** O formulário público pode criar cadastros pendentes em massa e disparar e-mails de confirmação para terceiros, queimando a reputação do domínio de e-mail. E responder "este CPF (ou e-mail) já usou o teste" deixa qualquer pessoa descobrir quem tem conta.

**Decisão.** O cadastro tem Cloudflare Turnstile e limite por IP e por e-mail, inclusive no reenvio da confirmação, com resposta genérica, no molde do limitador de auth que já existe. E-mail que já tem conta recebe sempre a mesma resposta ("enviamos um e-mail para continuar"), e o e-mail enviado orienta a entrar e usar "Criar minha agência". CPF que já usou o teste não bloqueia o cadastro: no fim, a pessoa é levada a escolher um plano pago, sem teste, com a mensagem neutra "o teste grátis não está disponível para este cadastro". A elegibilidade é decidida no backend, e nada a revela por outro meio: nem código de erro, nem diferença de tempo, nem formato da resposta da API.

**Consequência.** Nenhuma camada antifraude a mais antes da validação: as tentativas abusivas são monitoradas e os limites ajustados pelo uso real.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
