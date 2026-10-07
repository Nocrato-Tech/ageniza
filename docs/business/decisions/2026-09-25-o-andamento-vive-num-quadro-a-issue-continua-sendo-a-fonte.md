# O andamento vive num quadro; a issue continua sendo a fonte

**Data.** 2026-09-25

**Contexto.** Com quarenta e seis issues abertas em três módulos, a lista deixou de responder as duas perguntas que importam para um time de quatro pessoas: **o que dá para fazer em paralelo agora** e **o que está esperando o quê**. Label não expressa dependência, e menção no texto não expressa parentesco.

**Decisão.** Existe um quadro, [Ageniza — MVP](https://github.com/orgs/Nocrato-Tech/projects/1), vinculado ao repositório. Ele é **visão**, nunca fonte: aceite, dependências e esboço de tela continuam na issue.

- **Parentesco é nativo.** Épico, history e task estão ligados por **sub-issue** do GitHub, não por convenção de texto — a issue mostra a árvore com progresso, e o quadro mostra pai e progresso em campo próprio.
- **O campo `Onda`** é a camada de dependência: onda 1 começa hoje, onda 2 depende da 1 ter entrado. É ele que responde onde quatro pessoas trabalham sem fila.
- **`Bloqueio`** distingue esperar **dependência** de esperar **decisão** do dono do produto. Esperar **design** virou coluna, porque fila de designer precisa ser vista de longe, não filtrada.
- **Nove colunas**, terminando em duas que espelham o modelo de branch: *Pronto para subir* é mergeado em `develop`, *Em produção* é promovido para `main`.

O Projects novo só existe em nível de organização — projeto dono por repositório era o Projects clássico, descontinuado. O nosso está vinculado ao repositório, o que o faz aparecer na aba dele.

**Consequência.** O quadro só diz a verdade se quem pega uma task se atribuir a ela, e se quem descobre uma dependência nova atualizar a onda. Isso é disciplina, não automação. Em troca, "o que posso pegar agora" deixa de ser uma pergunta feita a outra pessoa.

**Origem.** Decidido em sessão. **Substituída em parte em 2026-09-28**, quanto ao que a coluna *Design* significa: ela deixa de ser a fila de telas esperando o designer e passa a receber telas já mergeadas para refino (ver a entrada de 2026-09-28, ao fim). Deixa de valer também a frase do bullet de `Bloqueio` sobre esperar design ("Esperar **design** virou coluna"): a tela não espera mais o designer, então esperar design não existe como bloqueio. As nove colunas e a distinção de `Bloqueio` entre dependência e decisão continuam valendo.

