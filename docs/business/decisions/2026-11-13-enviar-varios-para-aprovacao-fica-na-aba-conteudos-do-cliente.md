# "Enviar vários para aprovação" sai do Calendário e fica na aba Conteúdos do cliente

**Data.** 2026-11-13

**Contexto.** O envio de vários conteúdos de um cliente para aprovação, num só envio e num só e-mail, tinha o botão "Enviar vários para aprovação" no topo do Calendário Editorial, ao lado de "Novo conteúdo". O quadro aprovado do redesenho deixa o topo do Calendário só com "Novo conteúdo", e a aba Conteúdos do cliente, que já lista os conteúdos do mês agrupados por quem precisa agir, é o lugar natural de quem prepara um envio.

**Decisão.**

1. **O botão sai do Calendário.** O topo do Calendário Editorial fica só com "Novo conteúdo" (e "Nova publicação" no feed).
2. **O envio em lote parte da aba Conteúdos do cliente.** A pessoa marca, por caixa de seleção, os conteúdos que podem ir para aprovação e clica em "Enviar N para aprovação", com N igual ao número de marcados; sem nenhum marcado o botão fica desabilitado.
3. **Só pode ser marcado o que pode ir.** Em produção ou em ajuste, com mídia e sem subtarefa em aberto: a mesma regra de hoje. Os outros conteúdos aparecem sem caixa.
4. **É o mesmo envio de hoje.** Um cliente por vez, no máximo 30 conteúdos, o mesmo diálogo (prazo com padrão de 48 horas e recado), a mesma chamada à API, tudo ou nada, e um e-mail só ao cliente. Quem tem a permissão de operar conteúdo vê as caixas e o botão; cliente arquivado e plano só de leitura seguem como no Calendário.
5. **Depois do envio** a seleção é limpa e a lista é lida de novo.

**Consequência.**

- Só a tela muda: nenhuma rota, contrato, regra de negócio ou tabela.
- O fluxo mobile da agência passa a descrever o envio em lote a partir da aba Conteúdos do cliente.

**Origem.** Decisão do dono do produto em 2026-11-13, ao aprovar o quadro do redesenho (aba Conteúdos do cliente e Calendário).

**Validação.** Validada pelo dono em 2026-11-13.
