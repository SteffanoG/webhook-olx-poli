import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

// --- Configurações da API do Poli Digital ---
// Certifique-se de que estas variáveis estão configuradas no Railway
const POLI_API_TOKEN = process.env.POLI_API_TOKEN;
const BASE_URL = "https://cs.poli.digital/api-cliente"; // URL da documentação que você enviou
const API_HEADERS = {
  Authorization: `Bearer ${POLI_API_TOKEN}`,
  "Content-Type": "application/json",
};

// --- Lógica de Distribuição de Atendentes ---
// Pega a lista de IDs do ambiente, remove espaços e separa por vírgula
const operatorIds = (process.env.OPERATOR_IDS || "").replace(/\s/g, '').split(',').filter(Boolean);

// Rota de verificação para saber se o servidor está online
app.get("/", (req, res) => {
  res.send("🚀 Webhook para OLX Gestão Pro -> Poli Digital está no ar!");
});

// ===================================================================
// ROTA PRINCIPAL QUE RECEBE O WEBHOOK DA OLX
// ===================================================================
app.post("/", async (req, res) => {
  console.log("✅ Webhook da OLX recebido!");

  // Validação inicial para garantir que temos operadores configurados
  if (operatorIds.length === 0) {
    console.error("❌ ERRO CRÍTICO: Nenhum ID de operador configurado na variável de ambiente OPERATOR_IDS.");
    // Responde 500 para indicar um erro de configuração do servidor
    return res.status(500).json({ error: "Nenhum operador configurado para receber leads." });
  }

  // 1. Extrair e validar os dados do lead vindos da OLX
  const { name: leadName, phoneNumber, clientListingId: propertyCode } = req.body;
  if (!leadName || !phoneNumber || !propertyCode) {
    console.error("❌ Erro: Dados essenciais (nome, telefone ou código do imóvel) ausentes no webhook.");
    return res.status(400).json({ error: "Dados essenciais do lead ausentes." });
  }
  const leadPhone = phoneNumber.replace(/\D/g, ''); // Limpa o número de telefone

  try {
    // 2. Sorteia um operador da lista para receber o lead
    const selectedOperatorId = operatorIds[Math.floor(Math.random() * operatorIds.length)];
    console.log(`Lead de ${leadName} será atribuído ao operador com ID: ${selectedOperatorId}`);

    // 3. Executa o fluxo de ações na API do Poli Digital
    
    // Passo A: Verifica se o contato existe ou cria um novo
    // (Esta função ainda é um exemplo, precisa ser implementada com a chamada real da API)
    const contatoId = await findOrCreateContact(leadName, leadPhone, propertyCode);
    console.log(`Contato processado. ID do Contato: ${contatoId}`);

    // Passo B: Atribui o contato ao operador sorteado
    await assignContactToOperator(contatoId, selectedOperatorId);
    console.log(`Contato ${contatoId} atribuído ao operador ${selectedOperatorId}.`);

    // Passo C: Abre o chat para iniciar o atendimento
    const chatId = await openChat(contatoId);
    console.log(`Chat aberto para o contato ${contatoId}. ID do Chat: ${chatId}`);

    // Passo D: Envia a mensagem de template
    await sendTemplateMessage(chatId, leadName);
    console.log(`Template enviado para o chat ${chatId}.`);

    // 4. Se tudo deu certo, responde para a OLX
    console.log("✅ Fluxo completo executado com sucesso!");
    res.status(200).json({ status: "Lead recebido e processado com sucesso." });

  } catch (error) {
    console.error("❌ Erro durante o fluxo de processamento do lead no Poli:", error.message);
    res.status(500).json({ status: "Erro interno ao processar o lead." });
  }
});

// ===================================================================
// FUNÇÕES AUXILIARES PARA INTERAGIR COM A API DO POLI DIGITAL
// NOTA: Estas são estruturas de exemplo. Você precisará substituir
// as chamadas de API pelos endpoints e formatos corretos da documentação.
// ===================================================================

async function findOrCreateContact(name, phone, propertyCode) {
  // LÓGICA: Tentar buscar o contato pelo telefone. Se não achar, criar um novo.
  try {
    // Exemplo: Tenta buscar o contato
    const response = await axios.get(`${BASE_URL}/chats/contato/numero/${phone}`, { headers: API_HEADERS });
    console.log("Contato já existente encontrado.");
    return response.data.id; // Retorna o ID do contato existente
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // Se não encontrou (404), cria o contato
      console.log("Contato não encontrado. Criando um novo...");
      const newContactPayload = {
        nome: name,
        numero: phone,
        cpf: propertyCode, // Usando o campo CPF para o código do imóvel
      };
      const response = await axios.post(`${BASE_URL}/contatos`, newContactPayload, { headers: API_HEADERS });
      return response.data.id; // Retorna o ID do novo contato
    }
    // Se for outro tipo de erro, lança para o bloco catch principal
    throw new Error(`Erro ao buscar ou criar contato: ${error.message}`);
  }
}

async function assignContactToOperator(contactId, operatorId) {
  const payload = { atendenteId: operatorId };
  // Exemplo de chamada de API para atribuir
  await axios.put(`${BASE_URL}/chats/contato/${contactId}/atendente`, payload, { headers: API_HEADERS });
  return true;
}

async function openChat(contactId) {
  // Exemplo de chamada de API para abrir o chat
  const response = await axios.post(`${BASE_URL}/chats/contato/${contactId}/abrir`, null, { headers: API_HEADERS });
  return response.data.id; // Supondo que a resposta contenha o ID do chat
}

async function sendTemplateMessage(chatId, contactName) {
  const payload = {
    template: "abordagem2", // Nome do seu template
    // Os parâmetros dependem de como seu template foi configurado
    parametros: [contactName], 
  };
  // Exemplo de chamada de API para enviar o template
  await axios.post(`${BASE_URL}/chats/${chatId}/template`, payload, { headers: API_HEADERS });
  return true;
}

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
