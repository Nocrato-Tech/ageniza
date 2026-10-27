# Adicionar pessoa: o e-mail de boas-vindas que falha não desfaz o acesso

**Data.** 2026-10-27

**Contexto.** "Adicionar pessoa" dá o acesso na hora e manda um e-mail de boas-vindas (decisão de 2026-10-26, item 1). O envio acontece depois de o acesso ser gravado, como no convite que ele substitui.

**Decisão.** Se a entrega do e-mail falhar, a rota responde 502 `EMAIL_DELIVERY_FAILED` e o acesso **fica**. A agência vê o erro; adicionar o mesmo e-mail de novo responde 409 `ACCESS_EXISTS`, porque o acesso existe. Para mandar de novo a agência remove o acesso e adiciona o e-mail outra vez, o que mata os links de aprovação que o acesso tinha. O e-mail de boas-vindas conta no limite diário de e-mails da agência, no mesmo orçamento dos convites (decisão do trial, item 8): passado o limite, a rota responde 429 e nada é gravado.

**Consequência.** Não muda tabela. Um reenvio do e-mail de boas-vindas, se a agência precisar, é uma decisão à parte.

**Origem.** Implementação da issue #711, seguindo o padrão das rotas de convite.

**Validação.** Pendente de validação do dono.
