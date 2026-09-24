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

**Rastreio de alteração de dados.** `audit.events` registra ações específicas — convite enviado, agência ativada — não "quem mudou este campo e quando". Se auditoria de campo virar requisito, é retrofit em toda tabela de negócio.

**Exclusão reversível.** *Decidido na sessão 0.* `archived` é a entidade guardada e recuperável; `removed` é o vínculo desfeito. Nenhuma rota da aplicação exclui fisicamente entidade de negócio — purga só no fluxo de retenção e LGPD. Introduzir um `DELETE` de verdade reabre esta decisão.

**Contexto de cliente na mídia.** `media_assets` é escopado apenas por agência. Se o portal do cliente precisar ver só a mídia dele, é migration mais mudança de RLS — está registrado como pendente de validação em [decisions.md](decisions.md).

## O gate

Isto não depende de boa vontade. `scripts/ci/verify-structural-decisions.mjs` roda no CI e reprova a mudança quando uma migration alcança algo já implantado sem que [decisions.md](decisions.md) tenha sido tocado junto.

Ele cobre o banco, que é onde mudar de ideia custa mais caro. Mudança estrutural que vive só na API — um formato de resposta que os próximos módulos vão copiar, por exemplo — continua dependendo de quem revisa reconhecer o caso.
