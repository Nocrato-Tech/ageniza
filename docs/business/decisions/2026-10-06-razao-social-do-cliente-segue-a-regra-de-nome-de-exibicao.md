# Razão social do cliente segue a regra de nome de exibição
**Data.** 2026-10-06

**Contexto.** A #213 fez o nome do cliente e os campos de contato usarem a regra compartilhada de nome de exibição (#200); a SPEC (`specs/clientes.md`, seção 3) chama `legal_name` só de "razão social", texto livre, e não fixa essa regra para o campo.

**Decisão.** A razão social segue a mesma regra: recusa caracteres de controle, invisíveis de formato e overrides bidi, exige ao menos uma letra ou número, texto em branco vira `null` e o teto é em bytes (256). É exibida na tela; sem a regra, um caractere invisível ou bidi forja um nome.

**Consequência.** O `PATCH` passa a responder `400` para razão social fora da regra, e a edição do cadastro é o caminho para corrigir um valor antigo. Não há backfill.

**Origem.** Issues #213 e #299. **Pendente de validação pelo dono do produto.**

