# Conteúdo: roteiro de stories na tela, enviar grava antes e não pede confirmação

**Data.** 2026-10-11

**Contexto.** A SPEC (`specs/conteudo.md` §7) descreve o modal do roteiro: "data, cenas ordenadas (texto e orientação), adicionar e reordenar cena, **Enviar ao cliente**", e §4 diz que o envio passa o roteiro de rascunho a enviado. Não diz o que o botão faz com o que a pessoa acabou de digitar e não gravou, se o envio pede confirmação, nem como a tela trata o roteiro depois de enviado. A API (#258, #268) não remove cena, não edita roteiro enviado e aceita enviar um roteiro sem cenas.

**Decisão.**
1. **Enviar ao cliente grava antes o que está na tela, se mudou, e só então envia.** São duas chamadas, `POST`/`PATCH` e depois `POST …/send`. Se a gravação funcionou e o envio falhou, o roteiro fica salvo como rascunho, o modal continua aberto com o que foi digitado, e a nova tentativa envia **o mesmo roteiro**, sem criar outro.
2. **O envio não pede confirmação.** O botão se chama "Enviar ao cliente" e diz o que faz. Ele não se desfaz (o roteiro enviado não volta a rascunho), e é esse o motivo de a decisão estar registrada: quem quiser uma confirmação antes de enviar decide aqui.
3. **Roteiro enviado ou gravado abre só leitura para todos, também para quem tem `conteudo.operar`.** Rascunho abre só leitura para quem não tem `conteudo.operar`, e o cliente arquivado só se lê.
4. **A tela não remove cena.** Só adiciona (até 30) e reordena, como a SPEC e a API: uma cena acrescentada por engano num roteiro já salvo só sai fechando o modal sem gravar.
5. **O "+" do dia é só de quem tem `conteudo.operar` e de cliente ativo.** O menu dele lista apenas "Roteiro de stories"; "Conteúdo" entra com o modal do conteúdo (#264).

**Consequência.** Um erro num roteiro já enviado não tem correção na tela: a agência cria outro. Se o dono quiser confirmação no envio, ou poder corrigir o que o cliente já viu, é uma decisão nova que muda a API (`STORY_SCRIPT_STATE`) e esta tela.

**Origem.** Implementação da tela do roteiro de stories (#268).

**Validação.** Pendente de validação do dono.
