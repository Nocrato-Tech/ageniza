# ESTRUTURAL: o cliente ganha cidade, mostra o @ e "cliente desde", e "quem trabalha neste cliente" é derivado dos responsáveis

**Data.** 2026-11-11

**Contexto.** O cadastro do cliente tem razão social, CNPJ, segmento, site, @ do Instagram, contato e encerramento (`specs/clientes.md`, seção 3), mas não tem **cidade**. O quadro do redesenho (r0) mostra, no cabeçalho do cliente e na biblioteca de mídia, "Panificadora · São Paulo · cliente desde março de 2026", o @ ao lado do nome e os avatares de "Quem trabalha neste cliente". A decisão [`2026-09-26-estrutural-os-campos-do-cliente-entram-como-colunas-em`](2026-09-26-estrutural-os-campos-do-cliente-entram-como-colunas-em.md) pôs os campos como colunas de `clients`, e `ClientAssignment` nunca foi criado (`specs/clientes.md`, aviso do começo).

**Decisão.**

1. **Cidade.** O cliente ganha o campo **cidade** (texto livre opcional, até 80 caracteres), editado no cadastro e mostrado no cabeçalho ("Panificadora · São Paulo"). O portal vê a cidade do próprio cliente, como vê o resto do cadastro dele.
2. **O @ já existe.** O `@` é o `instagram_handle` que o cadastro já guarda (e o feed do calendário já lê). Esta decisão não cria campo: o @ passa a aparecer também no cabeçalho do perfil e nos blocos que o quadro mostra, e continua sem o `@` gravado.
3. **"Cliente desde".** É a data de criação do cadastro do cliente (que a tabela já tem), mostrada como "cliente desde <mês e ano>". Não é "início do contrato".
4. **"Quem trabalha neste cliente" é derivado.** Os avatares são os **responsáveis** dos conteúdos abertos do cliente (os que têm `owner`), do que tem mais conteúdos ao que tem menos, até um limite curto e com "+N". **Não existe atribuição de cliente a pessoa** e esta decisão não a cria: quem não é responsável por nenhum conteúdo do cliente não aparece. Vale a mesma permissão do calendário (`conteudo.visualizar`); sem ela, o bloco não aparece.

**Substitui.**

- Nada decidido: acrescenta a cidade ao cadastro de [`2026-09-26-estrutural-os-campos-do-cliente-entram-como-colunas-em`](2026-09-26-estrutural-os-campos-do-cliente-entram-como-colunas-em.md) e dá uso novo a campos que já existiam. A aviso "`ClientAssignment` não existe" de `specs/clientes.md` segue valendo e é citado nesta decisão.

**Consequência.**

- **É estrutural:** altera uma tabela que já existe (`clients` ganha a coluna `city`, anulável) e muda o formato do cadastro que a agência, o portal e o mobile leem. **Migration** nova (forward-only), grant por coluna para a edição, **sem backfill** (todo cliente começa sem cidade).
- **Risco: Alto** (banco e dado do cliente, lido pelo portal). Pede revisão de segurança independente: o portal só lê o cliente dele; o limite do campo; a coluna não entra em log nem na busca de outro cliente.
- `createdAt` passa a constar do contrato do cliente (leitura, sem mudança de tabela). A leitura de "quem trabalha" é derivada, sob a RLS de conteúdo.
- O fluxo mobile da agência descreve o cadastro e o cabeçalho.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro de acrescentar a cidade e de derivar "quem trabalha neste cliente".

**Validação.** Validada pelo dono em 2026-11-12.
