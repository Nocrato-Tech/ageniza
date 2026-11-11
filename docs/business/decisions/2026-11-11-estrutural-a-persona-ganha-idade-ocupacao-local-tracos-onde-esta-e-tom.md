# ESTRUTURAL: a persona ganha idade, ocupação, local, traços, "onde está" e "tom que funciona"

**Data.** 2026-11-11

**Contexto.** A persona do estudo de marca tem nome, descrição, dores, desejos e objeções (`client_personas`, `specs/clientes.md` seção 3). O quadro do redesenho (r0) mostra "Camila, a mãe que corre", "34 anos · gerente de RH · Pinheiros", chips de traços e, no perfil, as linhas Dor, Desejo, "Onde está" e "Tom que funciona", editáveis uma a uma. A decisão [`2026-09-26-campos-do-cliente-e-forma-do-estudo-de-marca`](2026-09-26-campos-do-cliente-e-forma-do-estudo-de-marca.md) fixou os campos da persona.

**Decisão.**

1. **Campos novos, todos opcionais:** **idade** (um número, de 1 a 120), **ocupação** (até 80 caracteres), **local** (a cidade ou o bairro, até 80), **traços** (até 5 chips, de até 24 caracteres cada), **"onde está"** (os canais e lugares em que a persona está, texto de até 280) e **"tom que funciona"** (texto de até 280).
2. **"Objeções" continua.** O campo existe e aparece no perfil junto de Dor e Desejo; o quadro não o mostra, e esta decisão não o tira. Persona sem os campos novos continua válida e aparece como antes.
3. **Edição por linha.** No perfil, cada linha (Dor, Desejo, Objeções, Onde está, Tom que funciona) tem o seu lápis e salva sozinha, sobre o mesmo `PATCH` da persona. A idade, a ocupação e o local formam a linha de apoio do cabeçalho ("34 anos · gerente de RH · Pinheiros").
4. **O portal lê os campos novos**, como lê o resto da persona ativa, em linguagem de cliente: são texto que a agência escreveu sobre o público do cliente e não dado de pessoa real. A persona arquivada continua sem aparecer no portal.
5. **Aviso de dado fictício.** O campo da persona é de uma persona, não de uma pessoa: o formulário diz para não pôr nome, telefone nem dado de uma pessoa real.

**Substitui.** Nada decidido: acrescenta campos à entidade de [`2026-09-26-campos-do-cliente-e-forma-do-estudo-de-marca`](2026-09-26-campos-do-cliente-e-forma-do-estudo-de-marca.md), que listava `name`, `description`, `pains`, `desires`, `objections` e `status`. `specs/clientes.md` (seção 3 e a aba Marca) é atualizada.

**Consequência.**

- **É estrutural:** altera uma tabela que já existe (`client_personas` ganha seis colunas anuláveis) e muda o formato da persona que a agência, o portal e o mobile leem. **Migration** nova (forward-only), grants por coluna para a edição, **sem backfill**. A RLS de `client_personas` não muda.
- **Risco: Alto**, por ser perfil de pessoa, ainda que fictícia, e por ser lido pelo portal. Pede revisão de segurança independente (o portal não lê persona arquivada nem de outro cliente; os limites de cada campo; o campo novo nunca entra em log).
- O fluxo mobile da agência descreve a persona.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro de manter "Objeções" e acrescentar os campos do quadro.

**Validação.** Pendente de validação do dono.
