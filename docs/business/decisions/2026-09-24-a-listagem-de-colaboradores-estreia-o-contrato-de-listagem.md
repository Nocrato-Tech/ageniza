# A listagem de colaboradores estreia o contrato de listagem

**Data.** 2026-09-24

**Contexto.** Nenhuma rota do produto lista nada. Esta é a primeira, e a sessão 0 fixou teto global de 100 com tamanho padrão declarado por rota.

**Decisão.** **24 por página, ordenado por nome ascendente.** Vinte e quatro é múltiplo de 3 e de 4, então a grade de crachás fecha em qualquer largura sem deixar linha quebrada. Ordem alfabética, não data de entrada: numa tela onde se procura uma pessoa específica, é a única ordem em que quem procura sabe onde olhar.

Busca por **nome e e-mail**; filtros por **papel** e **cargo**; todos como parâmetros nomeados.

**Convites pendentes ficam em seção separada**, não misturados à equipe. O banco já exige isso de fato: `invitations_select` pede `colaborador.convidar`, enquanto **todos** veem a equipe — na mesma lista, a mesma tela mostraria quantidades diferentes para pessoas diferentes, e "página 2" passaria a depender de quem olha.

**Quem foi removido fica fora da listagem por padrão**, visível por filtro explícito de status e **apenas para Admin e Owner**. Quem saiu não é informação de equipe, é informação administrativa — e é preciso encontrar a pessoa para reativá-la.

**Consequência.** Toda listagem seguinte copia esta rota como referência. A lista da equipe **nunca tem estado vazio**: quem olha está nela, e uma agência recém-ativada tem o Owner. Busca sem resultado é estado distinto de vazio, e precisa manter visível o termo buscado.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

