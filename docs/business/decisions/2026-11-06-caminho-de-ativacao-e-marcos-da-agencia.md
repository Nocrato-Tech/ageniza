# O Início da agência nova mostra um caminho de ativação de quatro passos e celebra os primeiros marcos

**Data.** 2026-11-06

**Contexto.** A agência nova chega ao Início sem nada e não sabe o próximo passo. O produto só rende quando o cliente aprova o primeiro conteúdo, então o caminho até lá precisa estar à vista, e as primeiras conquistas merecem reconhecimento.

**Decisão.**

1. **Caminho de ativação.** Enquanto a agência não tem a primeira aprovação de um cliente, o Início mostra "Primeiros passos", com quatro passos, cada um feito ou pendente: (1) cadastrar o primeiro cliente; (2) criar o primeiro conteúdo no calendário; (3) enviar o conteúdo para aprovação; (4) receber a primeira aprovação do cliente. A agência está **ativada** quando os quatro estão feitos; então o caminho some e o Início volta ao que era.
2. **Derivado dos dados.** O progresso vem do que já existe (cliente cadastrado, conteúdo criado, conteúdo que saiu da produção, conteúdo aprovado por uma pessoa do cliente). Não há "marcar como feito" nem estado novo. A aprovação fora da plataforma (a que a agência registra com motivo) não conta como aprovação do cliente. Editar, cancelar ou retirar a aprovação apaga o dado de aprovação do conteúdo; por isso, o que um navegador já registrou como feito continua feito ali, e o caminho não reaparece (o fato vale por navegador).
3. **Cada passo leva à tela que o resolve** (clientes, calendário do primeiro cliente, acessos do portal do cliente), e o botão só aparece para quem tem a permissão do passo; quem não pode vê o passo sem o botão. Com o plano em somente leitura, os botões de escrita não aparecem. O caminho aparece para quem vê clientes e conteúdos.
4. **Marcos celebrados, uma vez só por agência:** primeiro cliente cadastrado, primeiro conteúdo criado, primeiro conteúdo enviado para aprovação, primeira aprovação do cliente e primeiro conteúdo postado (estado `published`). A primeira aprovação ganha mensagem de parabéns e confete grande; os outros, um aviso leve com confete curto. Nada bloqueia a tela nem o clique, o confete some sozinho em poucos segundos e, para quem pede menos movimento, fica só a mensagem.
5. **Quando vários marcos chegam juntos**, só o maior é celebrado. Um marco já feito antes de a pessoa abrir o Início neste navegador não é celebrado: a primeira abertura só registra o que já existe.
6. **Conveniência de visualização.** Qual marco já foi celebrado fica no navegador, por agência. Trocar de navegador pode repetir a celebração do que ainda não foi visto ali; isso não é regra de negócio.

**Consequência.**

- Uma leitura nova, só de leitura e sem tabela nova: `GET /agencies/:agencyId/contents/activation`, que responde quatro fatos (há conteúdo, algum saiu da produção, algum foi aprovado pelo cliente, algum foi postado), sob a permissão `conteudo.visualizar`.
- O Início da agência e o fluxo mobile da agência ganham o caminho e os marcos.

**Origem.** O dono, em 2026-11-06, pedido direto (sem issue), com a mudança de escopo da celebração no mesmo dia.

**Validação.** Validada pelo dono em 2026-11-12.
