# A área da agência passa a ser clara, como o portal e a entrada: o app tem um tema só

**Data.** 2026-11-11

**Contexto.** A decisão [`2026-10-14-agencia-sempre-escura-portal-e-entrada-sempre-claros`](2026-10-14-agencia-sempre-escura-portal-e-entrada-sempre-claros.md) fixou o escuro na área da agência e o claro no portal, na entrada e nas páginas públicas. O dono aprovou em 2026-11-11 o redesenho do visual interno, com uma linguagem clara de blocos de cor suave (ver [`2026-11-11-nova-linguagem-visual-clara-com-blocos-de-cor-suave`](2026-11-11-nova-linguagem-visual-clara-com-blocos-de-cor-suave.md)), em que dois temas dividiriam o trabalho sem dar nada em troca.

**Decisão.**

1. Toda a agência roda no tema claro, o mesmo do portal, da entrada e das páginas públicas. O app tem **um tema só**: não há `data-theme`, folha escura, seletor de tema nem leitura de `prefers-color-scheme`.
2. Esta decisão **substitui** a de 2026-10-14. Aquela não é editada: continua no histórico, e esta é a que vale.
3. O que continua escuro é desenho de um elemento, não tema: o cabeçalho fixo da casca, a base do crachá do cliente e a moldura do celular do feed.
4. Um tema escuro opcional, escolhido pela pessoa, fica **fora do escopo**. Se um dia voltar, é decisão nova, com os pares de contraste conferidos.

**Consequência.**

- Os tokens ficam num `:root` só; a `DarkArea` e a folha `themes/dark.css` saem, e a tabela de contraste do design system vale só para o claro.
- Nenhuma regra de negócio muda: é uma decisão de apresentação.

**Origem.** O dono do produto, ao aprovar o redesenho interno em 2026-11-11.

**Validação.** Validada pelo dono em 2026-11-12.
