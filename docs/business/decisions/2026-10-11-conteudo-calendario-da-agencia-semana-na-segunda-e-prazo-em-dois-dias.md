# Conteúdo: o calendário da agência começa a semana na segunda e o prazo em dois dias conta o dia de hoje

**Data.** 2026-10-11

**Contexto.** A SPEC (`specs/conteudo.md` §4 e §7) diz que "atrasado" e "prazo em dois dias" são derivados e que o calendário tem mês e semana, mas não diz em que dia a semana começa, que dia vale como "hoje", se o aprovado e o em ajuste também têm prazo, nem quantos clientes o seletor em stories mostra. A tela (#262) precisa de uma resposta para cada um, e a #261 (sinais na carteira) precisa da mesma regra de prazo para que o anel do seletor e o card concordem.

**Decisão.**
1. **A semana começa na segunda** e vai até o domingo, como no esboço (`seg … dom`). O mês é desenhado em semanas inteiras: os dias dos meses vizinhos que caem na primeira e na última linha aparecem esmaecidos e entram na consulta por período (no máximo 42 dias, bem abaixo do teto de 93).
2. **"Hoje" é o dia de `America/Sao_Paulo`**, nunca o do navegador nem o de UTC. Às 22h30 do dia 11 em São Paulo (01h30Z do dia 12), hoje é o dia 11. O fuso por agência segue em aberto na SPEC (#153).
3. **Atrasado**: o dia planejado é anterior a hoje e o conteúdo não está publicado nem cancelado. **Prazo em dois dias**: o dia planejado é hoje, amanhã ou depois de amanhã (de 0 a 2 dias à frente, hoje incluído), pelo mesmo critério de estado. Valem para todo estado aberto: em produção, aguardando aprovação, em ajuste e aprovado ("pronto para publicar").
4. **O período está na URL**: `visao=semana` (o mês é o padrão e some da URL) e `data=AAAA-MM-DD`, o dia em torno do qual o período é desenhado (sem ele, hoje). Um valor que não é um dia real, ou uma visão que não existe, volta ao padrão. O cliente escolhido está no caminho (`/conteudos/:clienteId`).
5. **O seletor em stories mostra uma página da carteira**, no máximo 100 clientes ativos, na ordem do servidor (`sort=attention`), sem ordem própria. Acima disso a tela avisa "Mostrando N de M clientes"; paginar ou buscar os stories fica para quando uma agência passar disso.
6. **Feed e Pastas ficam fechados** (abas desativadas) e o espaço do feed à direita fica reservado até #263 e #267; criar conteúdo (botão e **+** do dia) entra com o modal da #264.

**Consequência.**
- A #261 usa a mesma janela (0 a 2 dias, dia de São Paulo) para o sinal de prazo do anel; se a janela mudar, muda nos dois lugares.
- Quem abrir a visão de Tarefas ou o portal reaproveita `content-dates.ts` para o dia de São Paulo e para as semanas.
- Mudar o primeiro dia da semana é trocar uma função; os conteúdos gravados não mudam.

**Origem.** Issue #262, decidido pelo implementador a partir do esboço da SPEC e acordado com o maestro.

**Validação.** Pendente de validação do dono.
