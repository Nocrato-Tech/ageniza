# Pauta: quem tem a vez decide a cor, e as quatro exceções às regras de superfície

**Data.** 2026-10-13

**Contexto.** O redesign Pauta (épico #621) refaz a área da agência sem trocar as cores do projeto. A direção, aprovada pelo dono no canvas v2, tem regras que as telas seguem e quatro pontos que abrem exceção à lista anti-slop da skill `impeccable` (nenhum gradiente, nada de glow ou vidro). Sem registro, a exceção é lida como regra geral ou como erro de revisão, e a regra "quem tem a vez decide a cor" ficava só no rascunho do goal, fora do repositório.

**Decisão.**
1. **Quem tem a vez decide a cor.** A cor de um estado do conteúdo diz de quem é a vez: em ajuste usa a cor da ação (a vez é da agência), aguardando aprovação usa o violeta (a vez é do cliente), pronto usa o teal, atrasado é o único estado em bloco cheio (vermelho cheio com texto branco), publicado e em produção recuam para o cinza. O estado nunca é só cor: vai sempre com ícone e rótulo, a cor fica no ícone e o rótulo em `text/secondary`.
2. **Degradê só na base do crachá do cliente.** A foto do crachá termina num degradê de índigo e violeta escurecidos sobre `ink/900` (`client-badge/fade/{start,end}`), com branco por cima a 9,5:1 ou mais. Sem glow, sem vidro, sem blur e sem degradê em texto, botão ou fundo de página; o degradê do símbolo da marca é do arquivo da marca, não vira estilo de interface.
3. **Cor do card por formato, estado na etiqueta.** No calendário, o fundo e o título do card são tingidos pelo formato (carrossel, reels, estático) e o estado vive na etiqueta, com ícone e rótulo. O atrasado passa por cima de tudo, com contorno vermelho no card inteiro (nunca borda lateral). Reels e aguardando dividem o violeta, e carrossel e pronto dividem o teal; o ícone e o rótulo desfazem a dúvida.
4. **Pílula (raio cheio) na ação do crachá e nos contadores.** O raio cheio, que era só do avatar, passa a valer também para `Pill` (contador ou rótulo curto) e `PillAction` (a próxima ação de um card).
5. **Navegação larga com grupos como shell da agência.** A navegação lateral com grupos (Trabalho e Agência) é o shell de toda a área da agência: aberta com 248 px, recolhível no trilho de 80 px e, no celular, barra inferior.
6. **Anti-slop.** Valem em toda tela da Pauta: sem rótulo acima do título nem numeração 01/02/03; sem borda colorida lateral em card, linha ou alerta; sem card dentro de card; sem número-herói sem a ação que ele pede; sem estado vazio mudo; sem cópia genérica; sem ícone genérico de pessoa no lugar de foto (iniciais); sem padrão do navegador esquecido (seleção, foco, barra de rolagem e cursor de texto na paleta); índigo cheio só nos usos da decisão de realce.

**Consequência.** `docs/design-system.md` passa a ter a seção 25 com estas regras, e as exceções 2 a 5 deixam de ser lidas como desvio nas revisões das telas da Pauta. As cores do projeto não mudam. O portal do cliente fica fora até o dono decidir sobre ele.

**Origem.** Épico #621 e issue #627; canvas v2 do redesign Pauta (folha Identidade e bloco "A confirmar com o dono"); aprovação do dono em 2026-10-13, com os quatro pontos.

**Validação.** Pendente de validação do dono.
