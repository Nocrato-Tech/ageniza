# Negócio

Regras de negócio, decisões de produto e a visão do domínio. É daqui que sai a resposta para "o sistema **deve** fazer isso?" — o código responde apenas o que ele **faz**.

- [Visão do produto](product-overview.md) — o domínio, os papéis e os fluxos. Comece por aqui se você chegou agora.
- [Decisões de negócio](decisions/) — o registro cronológico do que foi decidido e por quê, uma decisão por arquivo.
- [Mudanças estruturais](structural-changes.md) — leitura obrigatória antes de implementar algo novo.
- [Como um módulo é fechado](module-process.md) — o fluxo da entrevista até a issue, e o que cada artefato responde.
- [Anatomia de um módulo](../module-anatomy.md) — o molde que todo módulo da API segue.
- [Decisões arquiteturais](../adr/) — ADRs: escolhas técnicas com consequência de longo prazo.

## Por que o código não é a fonte da verdade aqui

Código e testes dizem o que o sistema faz hoje. Se eles também definissem o que ele deveria fazer, nenhum comportamento errado seria um bug — seria só comportamento, e regressão viraria "mudança".

Casos reais deste repositório:

- Criar dois convites equivalentes ao mesmo tempo devolvia `500`. Foi a issue #32 dizendo "criar convite revoga o pendente equivalente" que permitiu chamar aquilo de defeito.
- A permissão exigida pela rota de cancelamento divergia da exigida pela policy do banco (#39). Sem um prescritivo externo, não havia como saber qual dos dois lados estava errado.
- O teto de concorrência do worker foi reduzido de 4 para 2. A issue #24 pedia esse limite **para o job de vídeo**, não para o worker inteiro; sem isso, a redução passaria como decisão legítima.

A ponte entre o que está escrito aqui e o que roda em produção é o **teste**. Regra de negócio que nenhum teste verifica diverge do código em semanas.

## O que registrar

Toda decisão de negócio, qualquer que tenha sido o contexto em que foi tomada: conversa do time, sessão de trabalho com um agente, questionamento em cima de um plano, comentário de PR ou mensagem avulsa. Se a decisão muda o que o produto faz, ou fecha uma alternativa que alguém razoavelmente tentaria de novo, ela vira um arquivo em [decisions/](decisions/).

O sinal mais confiável de que algo precisa ser registrado é este: **alguém, daqui a três meses, vai olhar o código e perguntar "por que assim?"**. A resposta não pode depender de quem estava na conversa.

Não registre aqui: detalhe de implementação que o código já expressa, decisão técnica com consequência arquitetural (isso é um ADR) e regra permanente de como agentes devem trabalhar (isso é o `AGENTS.md`).

## Como registrar

Crie um arquivo novo em [decisions/](decisions/), no mesmo commit ou PR que implementa a decisão. O nome é a data mais um slug do título — `AAAA-MM-DD-<slug>.md`, minúsculo, sem acento, só `[a-z0-9]` e hífen, cortado em fronteira de palavra com no máximo 60 caracteres; duas decisões do mesmo dia ganham sufixo `-2`, `-3`. O arquivo tem:

- `# Título` na primeira linha, seguido de uma linha em branco — o que foi decidido, em uma linha;
- `**Data.** AAAA-MM-DD`;
- **contexto** — o que motivou a decisão e quais alternativas existiam;
- **decisão** — o que vale, de forma que dê para verificar;
- **consequência** — o que isso custa, impede ou exige depois;
- **origem** — issue, PR ou "decidido em sessão", para quem quiser o histórico completo.

O arquivo termina com uma linha em branco. Decisão que ninguém validou ainda entra com a linha:

> **Validação.** Pendente de validação do dono.

Quando o dono validar — respondendo na issue ou por mensagem ao maestro —, troque **somente** a linha `**Validação.**` por `**Validação.** Validada pelo dono em AAAA-MM-DD.` Essa é a única edição permitida num arquivo de decisão já registrado: corpo, data e título nunca mudam.

**Nunca edite o arquivo de outra decisão para registrar uma nova.** Para reverter uma decisão, crie um arquivo novo que cita a antiga. É melhor registrar uma decisão provisória e marcá-la do que deixá-la só na cabeça de quem implementou.
