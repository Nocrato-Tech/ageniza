# Portal — Marca: rótulos provisórios, Sugerir em cada seção e em cada persona, e as Observações à vista

**Data.** 2026-10-08

**Contexto.** A SPEC (`specs/clientes.md`, seção 7) e a issue #143 dizem que a Marca do portal mostra as sete seções em linguagem de cliente, com **Sugerir** "em cada seção e em cada persona ativa", e deixam os rótulos para o designer. O esboço da issue dá quatro rótulos ("Como sua marca fala", "Cores", "Posicionamento", "Quem é seu público") e desenha **Sugerir** só nas personas, sem dizer o que acontece com a conversa da seção **Personas** em si. Também não diz se **Observações**, que o portal recebe de `GET /clients/:clientId/brand-study` (decisão `2026-10-07-portal-le-o-cadastro-inteiro-e-o-inicio-conta-so-o`), aparece para o cliente.

**Decisão.**

1. Os rótulos da tela são provisórios, até o designer refinar: Branding é "Sobre sua marca", Tom de voz é "Como sua marca fala", Cores e Posicionamento ficam como estão, Arquétipo é "Personalidade da marca", Personas é "Quem é seu público" e Observações fica "Observações". O arquétipo aparece pelo nome em português.
2. **Sugerir** aparece em cada uma das sete seções preenchidas **e** em cada persona ativa: a seção "Quem é seu público" tem a conversa dela (assunto `personas`) além da de cada persona (assunto `personaId`), como na aba do estudo da agência. Seção não preenchida mostra "Sua agência está preparando esta parte" e não consulta nem abre conversa alguma.
3. **Observações** é mostrada ao cliente, preenchida, como qualquer outra seção, porque é o que a API do portal serve e a SPEC não a exclui.

**Consequência.** Os rótulos são texto de tela: o refino do designer os troca sem tocar em regra. Se o produto quiser Observações só para a agência, é uma mudança na API do portal (a seção sai da resposta) e a tela passa a mostrar seis seções. Se o produto quiser uma só conversa para "Quem é seu público", sai a conversa da seção ou a de cada persona, sem migration. Cada seção e cada persona faz a própria leitura de conversas (uma por assunto, como a API exige), então a tela de um estudo todo preenchido com N personas faz N + 7 leituras de lista.

**Origem.** Issue #143; `specs/clientes.md`, seções 3 e 7; decisões `2026-10-07-portal-le-o-cadastro-inteiro-e-o-inicio-conta-so-o` e `2026-10-07-conversa-persona-arquivada-recusa-abrir-thread`.

**Validação.** Pendente de validação do dono.
