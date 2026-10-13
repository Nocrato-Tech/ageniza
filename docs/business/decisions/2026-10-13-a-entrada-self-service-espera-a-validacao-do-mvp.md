# A entrada self-service espera a validação do MVP

**Data.** 2026-10-13

**Contexto.** A SPEC de entrada (cadastro público, teste grátis, planos e cobrança) foi entrevistada e aprovada no mesmo dia. Implementá-la são cerca de 23 tasks, com duas mudanças estruturais e integração de pagamento. Mas o produto ainda não foi testado por agências reais, e os limites, os preços e até o modelo de plano dependem de como ele vai ser usado.

**Decisão.** A implementação da entrada self-service fica adiada até a proposta do produto ser validada com agências reais. Até lá, a agência entra pelo caminho que já existe: contato com a operação, `pnpm cli:agency` e convite de ativação; a cobrança, se houver, é combinada fora do produto. A SPEC e as decisões de 2026-10-13 continuam valendo como o desenho a implementar, e podem ser revistas com o que o teste ensinar antes de virarem issues.

**Consequência.** O recorte em issues (`/modulo-issues entrada`) não é gerado agora. Gatilho para retomar: a operação deixar de dar conta de criar agências à mão, ou agências pedirem para entrar ou pagar sem falar com a operação, ou o dono decidir abrir as vendas. Antes de retomar, revisar preços, limites e o recorte do MVP à luz do uso real.

**Origem.** Conversa com o dono depois da aprovação da SPEC, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
