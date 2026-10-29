# Revisão de código

> **Nível de risco:** aplica-se aos níveis Médio e Alto. No Baixo, o maestro lê o diff (ver a seção Níveis de risco do [AGENTS.md](../AGENTS.md)).

O padrão de toda revisão de código de PR, feita por pessoa ou por agente de qualquer modelo. Quando o PR toca banco, RLS, autenticação, sessão, convite, armazenamento ou dado pessoal, a revisão de segurança é outra e segue [security-review.md](security-review.md).

A regra que sustenta o resto é a mesma da revisão de segurança: **um achado sem cenário concreto de falha não é achado**. Achado sem cenário é palpite, e palpite custa uma rodada inteira de correção e re-revisão sem proteger nada.

## Alvo

- Revise o head atual do PR: registre o commit revisado no topo da revisão. Se o head mudar no meio, a revisão vale para o commit registrado.
- Leia o diff, os chamadores e os contratos que ele afeta e os testes que dizem cobri-lo. O que você não leu entra como limitação, nunca como aprovado.
- O que outro revisor já cobriu e o despacho disse para não refazer, não refaça.

## Achado

Um por item, do mais grave ao menos grave:

```
1. [Alta|Média|Baixa] título curto — arquivo:linha
   Cenário: com que entrada ou estado, o que acontece de errado, e para quem.
   Correção sugerida.
```

- **Alta** impede o merge: regra da SPEC quebrada, regressão de fluxo principal, aceite sem teste que o prove, quebra de contrato que outra rota copia.
- **Média** é bug real de alcance limitado ou teste que não protege o que diz proteger.
- **Baixa** é clareza, nome ou endurecimento: não reabre o PR sozinha.
- Gosto pessoal, alternativa equivalente e "eu faria diferente" não são achados.
- Lista vazia é um resultado válido. Não procure achado para justificar a revisão.

## Estrutura e acoplamento

Estes casos seguem a mesma regra: o achado traz o cenário concreto de falha, não só o padrão.

- SDK de ferramenta externa (armazenamento, e-mail, OAuth, pagamento) importado fora do pacote dela é achado. A aplicação usa o pacote de `packages/`.
- Importar arquivo interno de outro módulo é achado. A dependência passa pelo que o módulo exporta (`register<Nome>Module`, guardas injetadas).
- Regra repetida em dois lugares é achado. Fica uma cópia só, injetada (ver `docs/module-anatomy.md`).
- Arquivo grande só é achado quando mistura responsabilidades, e o achado diz quais e como separar (serviço de domínio, subcomponente, repositório). O tamanho sozinho não é achado: `pnpm quality:file-size` só lista para revisão.

## Quando parar

- A re-revisão confere só os achados pedidos e se a correção trouxe regressão, no head novo. Ela não vira uma revisão nova do PR inteiro.
- Rodada nova só com evidência nova: código que mudou, ou um risco que ainda não foi verificado e é nomeado. Sem isso, a revisão termina.
- A contagem de rodadas não volta a zero depois de uma correção. Se o dono pediu um número de rodadas, ele vale para o PR inteiro.
- Achado de Baixa que sobrar vai para a issue dona como aceite adicional ou para uma issue de débito, e não segura o merge.
