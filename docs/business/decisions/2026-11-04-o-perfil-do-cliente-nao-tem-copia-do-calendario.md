# O perfil do cliente não tem cópia do calendário: um botão leva à tela de Conteúdos

**Data.** 2026-11-04

**Contexto.** A decisão de 2026-10-11 ([`2026-10-11-conteudo-a-aba-do-cliente-e-a-mesma-visao-e-os-numeros-do-card-da-carteira`](2026-10-11-conteudo-a-aba-do-cliente-e-a-mesma-visao-e-os-numeros-do-card-da-carteira.md)) pôs a mesma visão do calendário numa aba do detalhe do cliente, com o modal em endereços da própria aba. Na prática o calendário passou a ter dois endereços, dois conjuntos de testes e uma tela dentro de outra, e a tela de Conteúdos já é o lugar do calendário e do feed.

**Decisão.**

1. **Sem aba.** O detalhe do cliente não tem a aba Calendário Editorial. O calendário e o feed moram só em `/agencia/:agenciaId/conteudos/:clienteId`. A aba Mídias e o resto do perfil continuam.
2. **Botão no cabeçalho.** "Abrir no Calendário Editorial" leva à tela de Conteúdos com o cliente já selecionado, levando o estado de navegação da carteira. Aparece só com `conteudo.visualizar` (a regra da aba que existia); o cliente arquivado segue como a aba seguia, com o calendário só leitura.
3. **Voltar.** Na tela, "Abrir no cadastro do cliente" leva ao perfil (aba Geral) com o mesmo estado, e "← Clientes" ali volta à busca e à página de onde a pessoa saiu.
4. **Endereços antigos.** `/clientes/:clienteId/conteudos`, `/conteudos/novo` e `/conteudos/:conteudoId` redirecionam, com `replace`, para os equivalentes em `/conteudos/:clienteId`, mantendo a query (`visao`, `data`, `dia`, `vista`...) e o estado. Sem `conteudo.visualizar`, o endereço antigo segue sendo o mesmo "não encontrado". A API e o worker não geram links para esses endereços.
5. **Quem apontava para a aba.** O item "Calendário Editorial" do menu do card da carteira, "Resolver atraso" e "Ver prazos" vão direto à tela de Conteúdos do cliente.

Esta decisão **substitui os itens 1 a 3** da de 2026-10-11 (uma visão em dois endereços, o modal na aba, os dois endereços ligados). **Os itens 4 a 6 seguem valendo:** quem vê o que era a aba (agora o botão e a aba Mídias), os três números do card da carteira e a ordem da API.

**Substitui.** Os itens 1 a 3 de [`2026-10-11-conteudo-a-aba-do-cliente-e-a-mesma-visao-e-os-numeros-do-card-da-carteira`](2026-10-11-conteudo-a-aba-do-cliente-e-a-mesma-visao-e-os-numeros-do-card-da-carteira.md); os itens 4 a 6 seguem valendo.

**Consequência.**

- O modo `tab`/`pinned` da tela do cliente e o `ContentsHomeContext` saem; `content-address.ts` guarda só o endereço da tela.
- Quem guardou um link da aba continua chegando ao mesmo lugar.
- Se o dono quiser a aba de volta, é reverter esta decisão e a rota.

**Origem.** Dono, em 2026-11-04, nesta sessão.

**Validação.** Pendente de validação do dono.
