# O perfil do colaborador é uma página com a lista ao lado, e mostra "Clientes e o que está com ele"

**Data.** 2026-11-11

**Contexto.** O detalhe do colaborador é um modal sobre a lista da Equipe (`specs/colaboradores.md`, seção 7; decisão [`2026-09-24-escopo-do-modulo-de-colaboradores`](2026-09-24-escopo-do-modulo-de-colaboradores.md), item 7). O quadro do redesenho (r0) tem uma **página** com a trilha "Equipe > Nome" e a lista de pessoas à esquerda, e um cartão "Clientes e o que está com ele" (3 clientes, 6 conteúdos, 2 aguardando, e a lista "Com ele agora"). Como a carteira de clientes não tem atribuição (`ClientAssignment` não existe), o único vínculo entre pessoa e cliente é o responsável de cada conteúdo.

**Decisão.**

1. **Página, não modal.** O perfil de um colaborador (e o perfil próprio) é a página `/agencia/:agenciaId/colaboradores/:membershipId`, com a trilha "Equipe > Nome", a **lista de pessoas ao lado** (com busca) e o perfil à direita; em tela estreita, a lista fica numa tela e o perfil na outra. O endereço antigo `?colaborador=<id>` redireciona para a página. Cabeçalho, abas (Detalhes, com Performance e Entregas desativadas), a nota do e-mail, "Salvar" e "Remover do quadro" são os que o modal já tem, com as mesmas permissões.
2. **"Clientes e o que está com ele" é derivado.** O cartão lista, por cliente, os conteúdos **abertos** cujo **responsável é aquela pessoa** (em produção, em ajuste, aguardando aprovação, aprovado), com a contagem de conteúdos e a de "aguardando". Não existe atribuição de cliente a pessoa, e esta decisão não a cria: o vínculo é o responsável do conteúdo.
3. **Quem vê o cartão.** Só quem tem `conteudo.visualizar` (e vê aquele cliente), porque o cartão mostra títulos de conteúdo; para os demais, o cartão não aparece. A própria pessoa também precisa dessa permissão.
4. **Grade da Equipe.** A grade de crachás tem **três colunas** a partir de 64 rem (e se ajusta abaixo), como o design system já dizia. Uma página de 24 pessoas continua sem linha quebrada.

**Substitui.**

- O item 7 de [`2026-09-24-escopo-do-modulo-de-colaboradores`](2026-09-24-escopo-do-modulo-de-colaboradores.md) ("ver o detalhe de uma pessoa num modal com abas") e a seção "Detalhe: modal sobre a lista" de `specs/colaboradores.md`.
- A frase "3 ou 4 colunas conforme a largura" da seção 7 de `specs/colaboradores.md`, que contradizia `docs/design-system.md`: vale o design system (três colunas a partir de 64 rem).
- Em [`2026-10-07-o-modal-do-proprio-perfil-mostra-a-data-de-entrada-como-o`](2026-10-07-o-modal-do-proprio-perfil-mostra-a-data-de-entrada-como-o.md) só a palavra "modal": a data "Na agência desde" continua em todo perfil.

**Consequência.**

- Não é estrutural: nenhuma tabela muda. É uma leitura nova de colaboradores sobre conteúdos (sob a RLS de conteúdo) e uma rota de tela nova.
- O fluxo mobile da agência descreve a página e o cartão.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro de que o perfil vira página (e que o cartão é derivado dos responsáveis pelos conteúdos).

**Validação.** Pendente de validação do dono.
