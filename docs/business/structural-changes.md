# Mudanças estruturais

Leitura obrigatória antes de implementar qualquer coisa nova. São cinco minutos que evitam um retrofit.

A infraestrutura é incrementada conforme a necessidade aparece, e isso funciona porque o molde está pronto: módulo novo, permissão nova, job novo e tabela nova se encaixam no padrão existente sem tocar no que já existe.

**Mas nem toda mudança é local.** Algumas atravessam tudo o que já foi escrito, e aqui elas custam mais caro que o normal por três motivos: migration aplicada nunca se edita, RLS existe em toda tabela de negócio, e o primeiro módulo a resolver um problema vira o modelo que os próximos copiam.

## Como reconhecer

A mudança é estrutural se qualquer destas for verdadeira:

- exige alterar **tabelas que já existem**, não só criar novas;
- muda o **formato de resposta** que outras rotas já usam, ou vão copiar;
- mexe em **policies de RLS** de mais de um módulo;
- muda **como a autorização é avaliada**, não apenas quem pode o quê;
- precisaria de **backfill** de dados existentes para valer retroativamente.

Na dúvida, faça a pergunta ao contrário: *se decidirmos o oposto daqui a seis meses, quantos arquivos mudam?* Se a resposta passa de um módulo, trate como estrutural.

## O que fazer quando encontrar uma

1. **Pare antes de implementar.** Não resolva no meio de outra tarefa.
2. **Registre em um arquivo novo em [decisions/](decisions/)** — contexto, decisão, consequência — e diga explicitamente que é estrutural.
3. **Escreva a issue** com o alcance real, incluindo o que precisa ser migrado ou reescrito.
4. Só então implemente.

O erro caro não é escolher a opção errada; é escolher em silêncio, dentro de um PR que era sobre outra coisa.

## As que já conhecemos

Nenhuma precisa ser resolvida agora. Estão aqui para serem reconhecidas quando aparecerem numa conversa de módulo.

**Papéis personalizados.** *Adiado com gatilho na sessão 0.* O schema já suporta papel por agência, e tanto a RLS quanto o guard da API já o aceitam — o que não existe é tela nem regra. Ficou fora do MVP porque o catálogo tem quatro permissões e não há combinação a montar. Reabre quando uma agência precisar de uma combinação que os cinco presets não expressam.

**Formato de listagem.** *Decidido na sessão 0.* Paginação por página com o contrato de `packages/contracts/src/pagination.ts`, teto global de 100, tamanho padrão por rota declarado na SPEC, e filtro e ordenação como parâmetros nomeados por rota. Bloco de resumo não pagina. Mudar isso depois de a primeira listagem existir altera o `meta` de toda rota publicada — continua estrutural.

**Autorização dependente do valor.** *Decidido na sessão de colaboradores, e é estrutural.* Até aqui `app_private.has_agency_permission` responde "tem a chave?". A regra de que só o Owner concede o papel de Admin obriga a perguntar também "qual valor está sendo concedido?". Ela é expressa por duas permissões — `colaborador.alterar_papel` e `colaborador.atribuir_admin`, esta última sem preset —, toca a policy de `UPDATE` de `agency_memberships` e **substitui** a de `INSERT` de `invitations`. Qualquer regra futura do mesmo tipo segue este formato, não um `if` dentro da rota.

**Rastreio de alteração de dados.** `audit.events` registra ações específicas — convite enviado, agência ativada — não "quem mudou este campo e quando". Se auditoria de campo virar requisito, é retrofit em toda tabela de negócio.

**Exclusão reversível.** *Decidido na sessão 0.* `archived` é a entidade guardada e recuperável; `removed` é o vínculo desfeito. Nenhuma rota da aplicação exclui fisicamente entidade de negócio — purga só no fluxo de retenção e LGPD. Introduzir um `DELETE` de verdade reabre esta decisão. **Exceção (2026-11-12): a persona.** Ela se exclui de verdade, com a conversa dela, e não se arquiva: [`a-persona-se-exclui-com-a-conversa-e-nao-se-arquiva`](decisions/2026-11-12-estrutural-a-persona-se-exclui-com-a-conversa-e-nao-se-arquiva.md). Nenhuma outra entidade ganha essa exceção sem decisão própria.

**Contexto de cliente na mídia.** *Pendente, com gatilho na entrevista de Conteúdo.* `media_assets` é escopado apenas por agência, e o `SELECT` exige `midia.enviar` — hoje o portal não vê mídia nenhuma, nem a própria. Dar ao cliente a mídia dele é migration mais RLS nova; a forma — por arquivo, por pasta ou pelo conteúdo — depende do modelo de pastas que Conteúdo vai desenhar. Clientes não usa `media_assets`. *Atualização de 2026-11-11:* Conteúdo fechou a parte de cliente e pasta (a mídia tem `client_id` e `folder_id`), e o portal passa a ler e enviar **a própria mídia do pedido de material** ([`2026-11-11-estrutural-o-cliente-envia-material-pelo-portal`](decisions/2026-11-11-estrutural-o-cliente-envia-material-pelo-portal.md)); o portal continua sem biblioteca de mídia.

**Conversa com o cliente.** *Decidido na sessão de clientes, e é estrutural.* Uma tabela de threads por cliente, com `client_id` sempre preenchido e o assunto em colunas tipadas com chave estrangeira. Conteúdo **acrescenta** `content_id` nela, não cria uma segunda tabela de conversa. Tabela por assunto ou polimórfica sem chave estrangeira reabrem esta decisão.

**Trabalho agendado sem requisição.** *Decidido na sessão de clientes, e é estrutural.* A regra é que o worker age como um usuário e não contorna a RLS — com o defeito de virar no-op silencioso se esse usuário perder a permissão. Quando o efeito não pode deixar de acontecer, a exceção é uma **função `security definer` de escopo único, auditada**, chamada pelo job e pela rota equivalente; nunca uma identidade de serviço com acesso amplo. O arquivamento por encerramento de contrato é o primeiro caso; a publicação agendada de Conteúdo deve seguir a mesma forma.

**Permissões de convite compartilhadas entre tipos.** `convite.reenviar` e `convite.cancelar` valem para convite de colaborador e de cliente, e `invitations_select` não separa por tipo: quem recebe `cliente.convidar_usuario` vê também convites de colaborador. Invisível enquanto só o Admin detém as duas famílias. Separar por tipo reescreve três policies de `invitations`. Reabre quando um papel além do Admin precisar gerenciar um só dos dois tipos.

**Rodada de aprovação.** *Decidido em 2026-11-10, e é estrutural.* O envio para aprovação abre uma rodada numa tabela nova, uma linha por conteúdo enviado, com um identificador de lote comum (de um cliente só), prazo opcional (até 90 dias, dia de São Paulo) e recado opcional (até 500 caracteres). O conteúdo que já aguardava fica sem data de envio e sem prazo, sem backfill. Decisão: [`2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado`](decisions/2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado.md). Mudar a forma da rodada depois reescreve o formato do conteúdo, do portal e do link de aprovação.

**Lembretes de aprovação.** *Decidido em 2026-11-10, e é estrutural.* Dois tipos novos na fila de e-mail ("vence amanhã" e "venceu"), no máximo um de cada por rodada, só para pessoas ativas do portal e só para o que ainda aguarda, num trabalho diário que segue a forma de "Trabalho agendado sem requisição". Decisão: [`2026-11-10-estrutural-lembretes-de-aprovacao-vence-amanha-e-venceu`](decisions/2026-11-10-estrutural-lembretes-de-aprovacao-vence-amanha-e-venceu.md).

**Último acesso ao portal.** *Decidido em 2026-11-10, e é estrutural.* O acesso da pessoa do portal ao cliente (tabela existente) ganha a data e hora da última entrada, gravada ao entrar no contexto do cliente e ao usar o link de aprovação, e não gravada com a agência em somente leitura. Decisão: [`2026-11-10-estrutural-ultimo-acesso-ao-portal-por-cliente`](decisions/2026-11-10-estrutural-ultimo-acesso-ao-portal-por-cliente.md).

**Pedido de material.** *Decidido em 2026-11-10, e é estrutural.* Assunto novo da conversa do cliente (a tabela existente, no nível do cliente), com prazo opcional; só a agência abre, o cliente responde por comentário. Não fica dentro da conversa de um conteúdo, para não mexer na visibilidade da conversa de conteúdo em produção. Decisão: [`2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente`](decisions/2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente.md).

**O redesenho de 2026-11-11.** *Decididas em 2026-11-11, todas estruturais e **pendentes de validação do dono**; nenhuma foi implementada.* Cada uma tem a sua decisão, e nenhuma deve entrar num PR de outro assunto. Nenhuma tem backfill além do dito.

- **Prazo de aprovação com hora.** A rodada troca o dia (`due_on`) por um instante (`due_at`), com **backfill** do prazo antigo para 23h59 de São Paulo; padrão de 48 horas só na tela. Risco Alto (formato do conteúdo do portal e da rodada). [`2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas`](decisions/2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas.md).
- **Rodada: remetente e recado ao aprovar.** O portal lê o nome, a foto e a data de envio de quem enviou (o veto da migration da rodada cai só para esses campos), e a função de aprovar passa a gravar um comentário do cliente na conversa do conteúdo. Risco Alto. [`2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar`](decisions/2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md).
- **Notificações dentro do app.** Tabela nova por pessoa, RLS pelo destinatário e pela permissão de leitura do que a notificação cita, gravada por funções `security definer` de escopo único dentro das transações dos eventos (e por um job horário para "venceu o prazo"). Sem backfill. Risco Alto. [`2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos`](decisions/2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos.md).
- **Sessões ativas.** A sessão de autenticação ganha a cidade (do cabeçalho do Cloudflare) e a conta ganha três rotas de sessão; a RLS e o modelo de sessão global não mudam. Risco Alto. [`2026-11-11-estrutural-sessoes-ativas-na-conta-com-cidade-do-cabecalho-do-cloudflare`](decisions/2026-11-11-estrutural-sessoes-ativas-na-conta-com-cidade-do-cabecalho-do-cloudflare.md).
- **Pagamento simulado com cartão de teste.** Tabela nova com os quatro últimos dígitos, a validade e a marca (um por agência), leitura das cobranças como faturas e cotação com os dias; só onde o provedor simulado existe. Substitui a regra de que a tela nunca guarda nada do cartão. Risco Alto (pagamento). [`2026-11-11-estrutural-pagamento-simulado-no-dev-cartao-de-teste-faturas-e-compra-dos-planos`](decisions/2026-11-11-estrutural-pagamento-simulado-no-dev-cartao-de-teste-faturas-e-compra-dos-planos.md).
- **Mídia.** `media_assets` ganha nome, largura, altura e texto alternativo; passa a aceitar PDF, áudio e SVG (só como logo, com regra de servir e validação própria); a leitura de "onde é usada" cruza três módulos sob a RLS do conteúdo; e o cliente envia material pelo portal (a primeira vez que o portal escreve mídia). [metadados](decisions/2026-11-11-estrutural-a-midia-ganha-nome-dimensoes-texto-alternativo-renomear-e-mover.md), [tipos](decisions/2026-11-11-estrutural-a-midia-aceita-pdf-audio-e-svg-como-logo.md), [uso](decisions/2026-11-11-estrutural-a-midia-mostra-onde-e-usada-e-pode-abrir-um-conteudo.md), [envio pelo cliente](decisions/2026-11-11-estrutural-o-cliente-envia-material-pelo-portal.md). Risco Alto, exceto o de uso (Médio).
- **Persona, cliente, convidado e pedido de material.** Colunas novas anuláveis, sem backfill: seis em `client_personas` ([persona](decisions/2026-11-11-estrutural-a-persona-ganha-idade-ocupacao-local-tracos-onde-esta-e-tom.md)), `clients.city` ([cliente](decisions/2026-11-11-estrutural-o-cliente-ganha-cidade-e-quem-trabalha-nele-e-derivado.md)), o nome digitado em `client_portal_accesses`, que mexe numa regra anti-oráculo já revisada ([convidado](decisions/2026-11-11-estrutural-o-nome-do-convidado-digitado-pela-agencia-aparece-antes-da-entrada.md)), e o título do pedido de material ([pedido](decisions/2026-11-11-estrutural-o-pedido-de-material-ganha-titulo.md)). Risco Alto.

As demais decisões de 2026-11-11 (Agendado derivado, "Atrasado", abas do cliente, colaborador em página, busca, Ajuda, Início da agência e do portal, visual) **não são estruturais**: só leituras, rotas e telas, sem alterar tabela existente nem a forma de autorizar.

## O gate

Isto não depende de boa vontade. `scripts/ci/verify-structural-decisions.mjs` roda no CI e reprova a mudança quando uma migration alcança algo já implantado sem que um arquivo de [decisions/](decisions/) tenha sido tocado junto.

Ele cobre o banco, que é onde mudar de ideia custa mais caro. Mudança estrutural que vive só na API — um formato de resposta que os próximos módulos vão copiar, por exemplo — continua dependendo de quem revisa reconhecer o caso.
