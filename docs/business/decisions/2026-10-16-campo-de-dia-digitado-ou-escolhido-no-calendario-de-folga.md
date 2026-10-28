# O campo de dia é digitado ou escolhido num calendário com folga, no lugar do campo de data do navegador

**Data.** 2026-10-16

**Contexto.** Os campos de dia da tela de Conteúdos (o dia do roteiro de stories e os dias do conteúdo: publicação real, reagendamento e prazo de subtarefa) eram `<input type="date">`, cujo calendário é do navegador: apertado, fora da Pauta e diferente em cada um. Em teste manual, em 2026-10-16, o dono pediu um seletor de data bonito e com folga, no padrão da Pauta, mantendo o valor e a validação de hoje.

**Decisão.**
- O campo de dia passa a ser o componente `DatePicker` de `packages/ui`, o único componente novo da issue #703: um campo de texto em `dd/mm/aaaa` (a máscara põe as barras; um dia colado como `aaaa-mm-dd` também vale) com um botão que abre um calendário de seis semanas, segunda primeiro, de células e botões de 44 px.
- **O valor e a validação não mudam.** Quem usa o campo recebe `aaaa-mm-dd`, ou vazio enquanto o texto não for um dia inteiro e real; o dia de hoje continua sendo o de `America/Sao_Paulo` (quem chama passa `today`), e `CalendarDaySchema` segue sendo a regra. Um dia fora de `min` e `max` não se escolhe no calendário (fica desativado); digitado, é a validação de quem chama que recusa, como era com o campo nativo.
- **Teclado completo**: setas movem o foco entre os dias, Home e End vão ao começo e ao fim da semana, Page Up e Page Down mudam o mês (com Shift, o ano), Enter e Espaço escolhem, Alt+Seta para baixo abre o calendário a partir do campo, e Esc fecha só o calendário, devolvendo o foco ao botão, sem fechar o modal ao redor.
- O índigo cheio fica no "hoje" (um dos quatro usos da Pauta); o dia escolhido se preenche em tinta, nunca em índigo.

**Consequência.** Não há migration nem rota: é só tela. Os campos de dia do módulo de Clientes (encerramento do contrato) ficam com o campo nativo por ora, por não serem de Conteúdos; trocá-los é só usar o mesmo componente. O teste de cada campo passa a digitar `dd/mm/aaaa` e a ler o texto do campo, e o do `max` da publicação passa a conferir o dia futuro desativado no calendário.

**Origem.** Teste manual do dono em 2026-10-16; issue #703.

**Validação.** Pendente de validação do dono.
