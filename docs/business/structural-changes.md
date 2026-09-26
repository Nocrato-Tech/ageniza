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
2. **Registre em [decisions.md](decisions.md)** — contexto, decisão, consequência — e diga explicitamente que é estrutural.
3. **Escreva a issue** com o alcance real, incluindo o que precisa ser migrado ou reescrito.
4. Só então implemente.

O erro caro não é escolher a opção errada; é escolher em silêncio, dentro de um PR que era sobre outra coisa.

## As que já conhecemos

Nenhuma precisa ser resolvida agora. Estão aqui para serem reconhecidas quando aparecerem numa conversa de módulo.

**Papéis personalizados.** *Adiado com gatilho na sessão 0.* O schema já suporta papel por agência, e tanto a RLS quanto o guard da API já o aceitam — o que não existe é tela nem regra. Ficou fora do MVP porque o catálogo tem quatro permissões e não há combinação a montar. Reabre quando uma agência precisar de uma combinação que os cinco presets não expressam.

**Formato de listagem.** *Decidido na sessão 0.* Paginação por página com o contrato de `packages/contracts/src/pagination.ts`, teto global de 100, tamanho padrão por rota declarado na SPEC, e filtro e ordenação como parâmetros nomeados por rota. Bloco de resumo não pagina. Mudar isso depois de a primeira listagem existir altera o `meta` de toda rota publicada — continua estrutural.

**Autorização dependente do valor.** *Decidido na sessão de colaboradores, e é estrutural.* Até aqui `app_private.has_agency_permission` responde "tem a chave?". A regra de que só o Owner concede o papel de Admin obriga a perguntar também "qual valor está sendo concedido?". Ela é expressa por duas permissões — `colaborador.alterar_papel` e `colaborador.atribuir_admin`, esta última sem preset —, toca a policy de `UPDATE` de `agency_memberships` e **substitui** a de `INSERT` de `invitations`. Qualquer regra futura do mesmo tipo segue este formato, não um `if` dentro da rota.

**Rastreio de alteração de dados.** `audit.events` registra ações específicas — convite enviado, agência ativada — não "quem mudou este campo e quando". Se auditoria de campo virar requisito, é retrofit em toda tabela de negócio.

**Exclusão reversível.** *Decidido na sessão 0.* `archived` é a entidade guardada e recuperável; `removed` é o vínculo desfeito. Nenhuma rota da aplicação exclui fisicamente entidade de negócio — purga só no fluxo de retenção e LGPD. Introduzir um `DELETE` de verdade reabre esta decisão.

**Contexto de cliente na mídia.** *Pendente, com gatilho na entrevista de Conteúdo.* `media_assets` é escopado apenas por agência, e o `SELECT` exige `midia.enviar` — hoje o portal não vê mídia nenhuma, nem a própria. Dar ao cliente a mídia dele é migration mais RLS nova; a forma — por arquivo, por pasta ou pelo conteúdo — depende do modelo de pastas que Conteúdo vai desenhar. Clientes não usa `media_assets`.

**Conversa com o cliente.** *Decidido na sessão de clientes, e é estrutural.* Uma tabela de threads por cliente, com `client_id` sempre preenchido e o assunto em colunas tipadas com chave estrangeira. Conteúdo **acrescenta** `content_id` nela, não cria uma segunda tabela de conversa. Tabela por assunto ou polimórfica sem chave estrangeira reabrem esta decisão.

**Trabalho agendado sem requisição.** *Decidido na sessão de clientes, e é estrutural.* A regra é que o worker age como um usuário e não contorna a RLS — com o defeito de virar no-op silencioso se esse usuário perder a permissão. Quando o efeito não pode deixar de acontecer, a exceção é uma **função `security definer` de escopo único, auditada**, chamada pelo job e pela rota equivalente; nunca uma identidade de serviço com acesso amplo. O arquivamento por encerramento de contrato é o primeiro caso; a publicação agendada de Conteúdo deve seguir a mesma forma.

**Permissões de convite compartilhadas entre tipos.** `convite.reenviar` e `convite.cancelar` valem para convite de colaborador e de cliente, e `invitations_select` não separa por tipo: quem recebe `cliente.convidar_usuario` vê também convites de colaborador. Invisível enquanto só o Admin detém as duas famílias. Separar por tipo reescreve três policies de `invitations`. Reabre quando um papel além do Admin precisar gerenciar um só dos dois tipos.

## O gate

Isto não depende de boa vontade. `scripts/ci/verify-structural-decisions.mjs` roda no CI e reprova a mudança quando uma migration alcança algo já implantado sem que [decisions.md](decisions.md) tenha sido tocado junto.

Ele cobre o banco, que é onde mudar de ideia custa mais caro. Mudança estrutural que vive só na API — um formato de resposta que os próximos módulos vão copiar, por exemplo — continua dependendo de quem revisa reconhecer o caso.
