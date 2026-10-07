# Campos do cliente e forma do estudo de marca
**Data.** 2026-09-26

**Contexto.** `clients` tem apenas `name` e `status`. O bloco 0 pediu dados da empresa, contato do dono, foto e um estudo de marca "quanto mais detalhado, melhor", com personas múltiplas e sugestão do cliente por thread.

**Decisão.**

- **Cadastro**: nome de exibição, foto; razão social, CNPJ **ou** CPF, segmento, site, @ do Instagram; nome, telefone/WhatsApp e e-mail do contato do dono. **Só o nome é obrigatório** — o cadastro começa numa ligação e se completa depois. Valor de contrato, início e forma de pagamento ficam no Financeiro.
- **Nome único entre os clientes ativos da agência**, sem diferenciar maiúsculas. Arquivado não bloqueia o nome. **CNPJ não é único**: a mesma empresa pode ser atendida como duas marcas.
- **Estudo de marca em seções fixas do produto**: Branding, Tom de voz, Cores, Posicionamento, Arquétipo, Personas e Observações. Texto livre, exceto **Cores** — lista de nome e código — e **Arquétipo** — um dos doze clássicos. Seções configuráveis por agência e documento único foram descartados: o primeiro é um construtor de formulário, o segundo tira a âncora da conversa e impede medir preenchimento.
- **Personas**: várias por cliente, com nome, descrição, dores, desejos e objeções. Persona retirada é **arquivada**, porque pode ter conversa pendurada.
- **Conversa**: várias threads por seção e por persona. Comentário **não se edita nem se apaga**, nem pelo autor. A thread guarda quem resolveu e quando, e **comentário novo em thread resolvida a reabre**.
- **Histórico do estudo**: só quem alterou por último e quando, por seção. Versões ficam fora; a thread já registra o porquê.

**Consequência.** O @ do Instagram mora no cliente, e o simulador de feed de Conteúdo o lê daqui. A seção fixa é o que torna possível o "quanto do estudo está preenchido" na aba Geral. Onde esses campos vivem — colunas novas em `clients`, que é `alter table` em tabela implantada, ou tabelas próprias — é decidido no bloco de impacto estrutural desta entrevista.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

