# Revisão de segurança

Todo pull request que toque **banco, autenticação, sessão, autorização, convite, armazenamento, upload, infraestrutura ou dado pessoal** passa por esta revisão antes do merge, feita por quem **não escreveu o código**. Este documento é o padrão da revisão. Ele vale para qualquer revisor: pessoa, agente no Claude Code (`.claude/agents/security-reviewer.md`), no Maestri ou em outra ferramenta.

Não é uma lista para marcar. O revisor **tenta quebrar** o que o PR entrega e só afirma o que provou. A regra que sustenta tudo o resto é esta: **um achado sem cenário concreto não é achado, e uma aprovação sem ataque executado não é aprovação**.

## Por que existe

Nas primeiras rodadas de implementação (PRs #159, #162, #163 e #176), a primeira revisão achou falha em quase todo PR de banco. Estes são os casos que justificam o processo:

- um Gestor de conta movia o vínculo do Owner para si e virava Admin, até em outra agência, porque o *grant* de `UPDATE` valia para todas as colunas;
- a pessoa do portal criava uma thread já "resolvida" pelo `INSERT`;
- o deploy de produção e o `pnpm dev` quebravam por uma variável de ambiente nova;
- a leitura do "valor antigo" dentro de uma `WITH CHECK` era burlada por duas transações concorrentes.

Os testes do próprio PR passavam em todos esses casos. Quem testa só o que implementou testa o caminho feliz.

## Referências do mercado

A revisão segue estas referências, na versão mais recente publicada:

| referência | uso aqui |
|---|---|
| **OWASP ASVS**, nível 2 | requisito verificável de autenticação, sessão, controle de acesso, validação, criptografia, logs e configuração |
| **OWASP API Security Top 10** | a lista de ataque padrão contra cada rota nova: BOLA, autenticação quebrada, BOPLA (propriedade exposta ou gravável), consumo sem limite, BFLA (função sem autorização), SSRF, configuração insegura, inventário de API |
| **OWASP Top 10** (aplicações web) | a interface: injeção, XSS, falhas de controle de acesso, falhas de integridade |
| **CWE Top 25** | a classificação dos achados, para que cada um tenha nome e severidade comparáveis |
| **LGPD** | dado pessoal: minimização, finalidade, retenção e o que aparece em log e em resposta |
| **Supply chain** (SLSA, OpenSSF Scorecard como referência) | dependência nova, script de `postinstall`, ação de CI de terceiro |

## O que o revisor faz, nesta ordem

### 1. Entender o que o PR promete
Leia a issue inteira, a seção da SPEC, as entradas de `docs/business/decisions.md` que a issue cita e [`docs/business/structural-changes.md`](business/structural-changes.md). Liste as **fronteiras de confiança** que o PR toca: quem chama, com qual credencial, o que atravessa para o banco, para o armazenamento ou para o navegador.

### 2. Modelar a ameaça em uma página
Para cada rota, tabela ou tela nova, responda por escrito: quem são os atores (anônimo, pessoa do portal, cada papel da agência, Owner, worker, operação) e o que cada um **não pode** conseguir. Isso vira a lista de ataques do passo 3.

### 3. Atacar, executando

Sempre num **banco isolado** e num **worktree temporário fora do repositório**. Nunca no banco `ageniza`, nunca recriando containers compartilhados:

```sh
docker exec ageniza-local-postgres-1 psql -U postgres -c "create database ageniza_rev<N>"
export MIGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/ageniza_rev<N>
export DATABASE_URL=postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza_rev<N>
```

Os ataques de banco rodam como **`ageniza_app`**, nunca como `postgres`, que ignora RLS e *grants*. O contexto do usuário é definido como os testes fazem (`set_config('app.user_id', …, true)`). Ao final, apague o banco e o worktree.

A lista mínima, adaptada ao que o PR toca:

**Banco e RLS**
- Ler e escrever dado de **outra agência**, de **outro cliente da mesma agência**, e sem vínculo algum.
- Mudar colunas de tenant e de identidade (`id`, `agency_id`, `client_id`, `user_id`, assunto, autor, lado) por `UPDATE` **e** por `INSERT`.
- Forjar colunas que o banco deveria fixar: `created_at`, `resolved_at`, `resolved_by`, `updated_by`, `status`.
- Conceder a si mesmo mais do que tem, como papel, admin ou posse.
- **Concorrência**: duas transações reais ao mesmo tempo contra a mesma linha (`READ COMMITTED` reaplica o `UPDATE` na versão nova).
- Funções `security definer`: `search_path` fixo, `revoke … from public`, e **toda** checagem de permissão escrita dentro da função.
- GUC de contexto (`app.user_id`): `ageniza_app` consegue chamar `set_config` no meio de uma instrução. Nenhuma regra pode depender de ele não fazer isso.
- DELETE físico de entidade de negócio.

**API**
- **BOLA**: trocar o id da URL por o de outro tenant. Precisa dar 404, sem revelar que o recurso existe.
- **BFLA**: cada papel contra cada rota de escrita. Teste com **papel personalizado de uma permissão só**, porque o Admin tem todas e esconde guarda com a permissão errada.
- **BOPLA**: campo a mais no corpo (`.strict()`), campo sensível na resposta (hash, token, dado de outro).
- Entrada hostil: tamanhos extremos, `page=1e20`, unicode, NBSP, tipos trocados, JSON profundo.
- Corpo malformado, corpo declarado como JSON e vazio, ou `content-type` inesperado: esperam **400/415**, sem `log.error` nem evento no Sentry, e sem ecoar trecho do corpo na resposta.
- Erro vira 500? Todo 500 provocável por entrada é achado.
- Oráculo: a resposta ou o tempo revelam se um e-mail, uma conta ou um recurso existe?
- Rate limit nas rotas de credencial e de envio de e-mail.

**Autenticação e sessão**
- Sessão antiga sobrevive a reset de senha, logout-all ou remoção de vínculo?
- Sessão criada e depois revogada deixa janela utilizável ou cookie aplicado?
- Token de convite, de reset ou de sessão aparece em URL persistida, log, `Referer`, storage do navegador ou resposta?
- Open redirect a partir de `state`, query ou destino guardado.
- CSRF: rota de escrita sem a proteção de origem global.

**Armazenamento e upload**
- Tipo validado pelo **conteúdo** (magic bytes), não pelo header nem pela extensão; SVG e HTML recusados.
- Tamanho aplicado antes de ler o corpo inteiro na memória.
- Chave de objeto derivada só de ids validados no servidor, sem path traversal.
- URL assinada: só GET, validade curta, `Content-Type` e `Content-Disposition` forçados. Nada público.

**Interface**
- XSS: todo texto vindo do servidor ou do usuário é renderizado como texto. Qualquer `dangerouslySetInnerHTML` ou HTML montado é achado até prova em contrário.
- Dado de uma conta aparecendo depois do login de outra (cache não limpo).
- Links externos com `rel="noopener noreferrer"`.

**Infraestrutura e CI**
- Variável de ambiente nova entra em `infra/vps/ageniza-deploy.sh` (allowlist), em `scripts/docker/local-stack.mjs` e nos exemplos. **O CI não pega isso.**
- Segredo commitado, placeholder aceito em produção, porta publicada (nunca a do PostgreSQL).
- Dependência nova: justificada, mantida, sem `postinstall` inesperado, com `pnpm audit` limpo nas severidades alta e crítica.

**Logs e LGPD**
- Nenhum log com senha, token, hash, e-mail completo ou dado pessoal além do necessário.
- A resposta devolve só o que a tela precisa. Campo "interno da agência" nunca em tabela que o portal lê.

### 4. Conferir os testes do PR
Para cada item de aceite, pergunte: **este teste falharia com o código errado?** A forma mais barata de responder é a **mutação**: altere a linha que implementa a regra (troque a permissão, remova um filtro, inverta um `>`), rode a suíte e veja se ela fica vermelha. Teste que continua verde com a regra removida é achado.

Sinais de teste fraco:
- afirma só que "não deu erro", quando a RLS filtra em silêncio e o certo é conferir a contagem de linhas ou o estado final;
- usa fake que responde diferente da API real, como 204 onde a real dá 401;
- injeta no fake o valor que o código deveria calcular sozinho;
- afirma "Page not found" em vez da rota de destino.

### 5. Publicar
Uma revisão por PR, com `gh pr review <N> --comment` e **nunca** `--approve` ou `--request-changes`, porque o merge é decisão do orquestrador. Em português:

```
Veredito: APROVADO | APROVADO COM RESSALVAS | MUDANÇAS NECESSÁRIAS

O que foi verificado e como (banco isolado, commit, suítes, ataques executados)

Achados
1. [Crítica|Alta|Média|Baixa] título curto — arquivo:linha
   Cenário: quem, fazendo o quê, consegue o quê.
   Evidência: o comando ou teste que provou, e o resultado.
   Correção sugerida.

O que está correto (o que foi tentado e resistiu)
```

**Severidade:**

| | quando |
|---|---|
| **Crítica** | escalada de privilégio, acesso a outro tenant, sessão ou credencial comprometida |
| **Alta** | quebra de regra inviolável da SPEC, dado pessoal exposto, regressão de fluxo principal, deploy quebrado |
| **Média** | 500 provocável, oráculo fraco, defesa em profundidade ausente, teste que não protege o aceite |
| **Baixa** | endurecimento, clareza de log, lacuna de teste secundária |

Crítica ou Alta impede o merge. Uma Média de segurança também impede, salvo decisão registrada em `decisions.md` com follow-up aberto, como o #166.

### 6. Re-revisão
Depois da correção, a re-revisão refaz **os mesmos ataques** e procura regressão introduzida pela correção. Nas rodadas reais, a correção de uma falha trouxe outra mais de uma vez: o trigger que resolveu a corrida quebrou o reaceite de convite, e a correção do logout em `/contextos` mandou quem perdeu o acesso para `/entrar`.

## Lições que já custaram caro

O registro detalhado vive no ai-memory, em `notes/licoes-seguranca-rls.md`. As regras que viraram padrão:

- *Grant* de `INSERT` e `UPDATE` **por coluna**, sempre.
- Comparação de valor antigo com novo por **trigger `BEFORE UPDATE`**, `security invoker`, pulando só quando `current_user <> 'ageniza_app'`. Nunca por subselect na `WITH CHECK`.
- Valor que o cliente não escolhe (`created_at`, autor, lado, quem resolveu) é fixado pelo banco.
- O lado de quem escreve (agência ou cliente) vem da rota e é conferido pela credencial, nunca pelo corpo.
- Teto de página é **limitar**, e `page` gigante não pode virar 500.
- Upload validado pelo conteúdo; URL assinada com tipo forçado.
- Mudança de ambiente entra na allowlist do deploy.
