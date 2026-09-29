import { DRAFT_NOTICE, list, paragraph, type LegalDocument } from './document.js';

export const privacyPolicy: LegalDocument = {
  title: 'Política de Privacidade',
  version: '2026-02-01',
  draftNotice: DRAFT_NOTICE,
  sections: [
    {
      heading: 'Quem trata os seus dados',
      blocks: [
        paragraph('O Ageniza é operado por [PENDENTE: razão social], inscrita no CNPJ sob o nº [PENDENTE: CNPJ]. O encarregado pelo tratamento de dados pessoais é [PENDENTE: nome e contato do encarregado].'),
        paragraph('Parte dos dados guardados no Ageniza é inserida pelas agências sobre os seus próprios clientes e colaboradores. [PENDENTE: enquadramento, perante a LGPD, de quem é controlador e quem é operador de cada conjunto de dados, em especial dos dados que a agência cadastra sobre os clientes dela.]'),
        paragraph('Esta Política descreve o que o sistema faz com os dados. Ela é aceita junto com os Termos de Uso, ao criar a conta.')
      ]
    },
    {
      heading: 'Dados da sua conta',
      blocks: [
        paragraph('Para que você entre e use o Ageniza, guardamos:'),
        list([
          'nome e e-mail. O e-mail é o do convite que criou a conta, e é ele que identifica você;',
          'a senha, guardada apenas em forma cifrada (hash), nunca como texto legível;',
          'a foto de perfil, se você enviar uma;',
          'as versões dos Termos de Uso e desta Política que você aceitou, com data e hora;',
          'as agências e os clientes a que você tem acesso, com o seu papel, o seu cargo, a data de entrada e se o acesso está ativo ou foi removido;',
          'o último espaço de trabalho que você usou, para abrir direto nele da próxima vez.'
        ])
      ]
    },
    {
      heading: 'Dados da sessão e de segurança',
      blocks: [
        paragraph('Quando você entra, o navegador recebe um cookie de sessão. Ele não é acessível por scripts da página e serve apenas para manter você conectado. Junto com a sessão, guardamos o endereço IP e a identificação do navegador (user agent) de onde ela foi aberta, além da data de expiração.'),
        paragraph('Para limitar tentativas de entrada e de redefinição de senha, contamos as tentativas por endereço IP e por e-mail. Essa contagem usa apenas um resumo criptográfico (hash) do IP e do e-mail, fica apenas na memória do servidor, e deixa de valer ao fim de cada janela de contagem, que dura de 15 minutos a 1 hora.'),
        paragraph('Algumas ações ficam registradas num histórico interno de auditoria: qual ação foi feita, por quem, em qual agência, sobre qual registro e quando.'),
        paragraph('Os registros técnicos de funcionamento do servidor anotam cada requisição com um identificador, a rota, o resultado e a duração. Eles não registram senhas, tokens, cookies nem o conteúdo das requisições. Em produção, erros inesperados são enviados a um serviço de monitoramento de erros. Antes do envio, o sistema retira do relatório o conteúdo das requisições, o endereço da página, cookies e credenciais. [PENDENTE: confirmar na configuração do serviço de monitoramento se o endereço IP de quem teve o erro é guardado.]'),
        paragraph('O Ageniza não usa cookies de publicidade nem de análise de navegação.')
      ]
    },
    {
      heading: 'Convites e redefinição de senha',
      blocks: [
        paragraph('Um convite guarda o e-mail de destino, a agência, o cliente quando houver e o papel oferecido. O link do convite contém um código que só existe no e-mail enviado: guardamos apenas um resumo criptográfico dele, e nem a nossa operação consegue recuperá-lo depois do envio. O convite vale por 7 dias.'),
        paragraph('O link de redefinição de senha segue o mesmo cuidado, e vale por 30 minutos.')
      ]
    },
    {
      heading: 'Dados que a agência cadastra',
      blocks: [
        paragraph('Para trabalhar, a agência cadastra no Ageniza dados dos seus clientes:'),
        list([
          'nome, razão social, CNPJ ou CPF, segmento, site e perfil do Instagram;',
          'nome, telefone e e-mail de contato do cliente, que não precisam ser os de quem acessa o portal;',
          'foto do cliente;',
          'o estudo de marca: posicionamento, tom de voz, cores, arquétipo, personas e observações.'
        ]),
        paragraph('Os comentários trocados nas conversas entre a agência e o cliente guardam o autor, o lado de quem escreveu (agência ou cliente) e a data, e não podem ser editados nem apagados. No portal, o cliente vê o nome e a foto de quem respondeu pela agência.')
      ]
    },
    {
      heading: 'Arquivos de mídia',
      blocks: [
        paragraph('Imagens e vídeos enviados vão direto do navegador para um armazenamento privado, sem passar pelo nosso servidor. Guardamos junto o tipo, o tamanho, a data e quem enviou.'),
        paragraph('Depois do envio, o servidor confere o arquivo que chegou. Arquivo fora do tipo permitido, acima do tamanho máximo ou além da quota da agência é apagado. Para vídeos, um processo interno gera uma miniatura e uma prévia em até 720p; o original não é alterado.'),
        paragraph('O acesso a um arquivo é feito por um endereço temporário, emitido só para quem tem permissão na agência, e que expira em poucos minutos.')
      ]
    },
    {
      heading: 'Para que usamos os dados',
      blocks: [
        paragraph('Usamos os dados para:'),
        list([
          'identificar você, manter a sua sessão e decidir a que você tem acesso;',
          'prestar o serviço: guardar e mostrar os dados de agências, clientes, conversas e arquivos a quem tem acesso a eles;',
          'enviar e-mails de serviço: convites e links de redefinição de senha. O Ageniza não envia e-mail de marketing;',
          'proteger as contas e o sistema: limitar tentativas, registrar ações de auditoria e investigar erros.',
          '[PENDENTE: base legal de cada finalidade, segundo o art. 7º da LGPD.]'
        ])
      ]
    },
    {
      heading: 'Quem vê os seus dados dentro do Ageniza',
      blocks: [
        paragraph('Os dados de uma agência são isolados das outras agências, e esse isolamento é imposto também pelo próprio banco de dados, não só pela aplicação.'),
        paragraph('Dentro de uma agência, todos os colaboradores veem todos os clientes dela e a equipe inteira, com nome, foto, e-mail, cargo e papel. As pessoas do portal de um cliente veem apenas os dados daquele cliente e nunca o trabalho interno da agência. Quem administra a agência vê quem tem acesso ao portal de cada cliente.')
      ]
    },
    {
      heading: 'Com quem compartilhamos',
      blocks: [
        paragraph('Não vendemos dados. Para funcionar, o Ageniza depende de prestadores que tratam dados em nosso nome:'),
        list([
          'Hostinger, onde ficam o servidor da aplicação e o banco de dados;',
          'Cloudflare, por onde passa todo o acesso ao Ageniza, e onde ficam os arquivos de mídia e as cópias de segurança do banco;',
          'o serviço de envio de e-mail: [PENDENTE: provedor de e-mail transacional de produção, ainda não escolhido];',
          'Sentry, que recebe os relatórios de erro em produção.'
        ]),
        paragraph('[PENDENTE: onde cada prestador guarda os dados, se há transferência internacional, e com quais garantias.]')
      ]
    },
    {
      heading: 'Como os dados são protegidos',
      blocks: [
        paragraph('O banco de dados não é acessível pela internet. Os arquivos ficam em armazenamento privado. Senhas e códigos de convite e de redefinição são guardados apenas em forma cifrada. Todo acesso ao Ageniza é feito por conexão criptografada.'),
        paragraph('Fazemos uma cópia de segurança criptografada do banco de dados por dia, guardada fora do servidor principal.')
      ]
    },
    {
      heading: 'Por quanto tempo os dados ficam guardados',
      blocks: [
        paragraph('O produto não apaga dados de negócio pelo uso normal: um cliente encerrado é arquivado, e um colaborador ou pessoa do portal removido perde o acesso, mas o registro permanece. A exclusão definitiva de dados acontece apenas por um processo próprio de retenção e de atendimento à LGPD, separado do produto. [PENDENTE: esse processo e os seus prazos.]'),
        paragraph('Os prazos que o sistema já aplica são estes:'),
        list([
          'uma sessão expira depois de 7 dias, e tem um limite máximo de duração mesmo com uso contínuo;',
          'o link de redefinição de senha vale 30 minutos, e o convite, 7 dias;',
          'a contagem de tentativas deixa de valer ao fim de cada janela, de até 1 hora;',
          'arquivos recusados são apagados na conferência; envios temporários não concluídos são apagados depois de um prazo curto [PENDENTE: prazo];',
          'dados da conta, da agência e dos clientes: [PENDENTE: prazo de guarda enquanto a conta existe e depois do fim do uso];',
          'registros técnicos e histórico de auditoria: [PENDENTE: prazo];',
          'cópias de segurança: [PENDENTE: prazo de retenção].'
        ])
      ]
    },
    {
      heading: 'Seus direitos',
      blocks: [
        paragraph('A Lei Geral de Proteção de Dados (Lei nº 13.709/2018) garante a você, entre outros, o direito de confirmar se tratamos seus dados, acessá-los, corrigi-los, pedir a anonimização, o bloqueio ou a eliminação de dados desnecessários ou tratados em desconformidade, pedir a portabilidade, saber com quem os compartilhamos, e revogar o consentimento quando ele for a base do tratamento.'),
        paragraph('Pelo próprio produto, você pode alterar o seu nome e a sua foto. O e-mail da conta não pode ser alterado pelo produto nesta versão, e não há função para excluir a conta.'),
        paragraph('Para exercer os demais direitos: [PENDENTE: canal de atendimento ao titular e prazo de resposta]. Se o pedido envolver dados que uma agência cadastrou sobre você, [PENDENTE: como o pedido é encaminhado à agência].')
      ]
    },
    {
      heading: 'Crianças e adolescentes',
      blocks: [
        paragraph('[PENDENTE: posição sobre o uso por menores de idade.]')
      ]
    },
    {
      heading: 'Mudanças nesta Política',
      blocks: [
        paragraph('Cada versão desta Política é identificada pela data que aparece no topo, independentemente da versão dos Termos de Uso. Ao criar a conta, registramos a versão que você aceitou, com data e hora.'),
        paragraph('[PENDENTE: como uma versão nova é comunicada e se exige novo aceite, ponto que specs/auth.md mantém em aberto.]')
      ]
    },
    {
      heading: 'Contato',
      blocks: [
        paragraph('[PENDENTE: canal de contato para assuntos de privacidade, se diferente do encarregado.]')
      ]
    }
  ]
};
