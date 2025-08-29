import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

// --- Configurações da API do Poli Digital ---
const POLI_API_TOKEN = process.env.POLI_API_TOKEN;
const BASE_URL = "https://cs.poli.digital/api-cliente";
const API_HEADERS = {
  Authorization: `Bearer ${POLI_API_TOKEN}`,
  "Content-Type": "application/json",
};

// --- Lógica de Distribuição de Atendentes ---
const operatorIds = (process.env.OPERATOR_IDS || "").replace(/\s/g, '').split(',').filter(Boolean);

app.get("/", (req, res) => {
  res.send("🚀 Webhook para OLX Gestão Pro -> Poli Digital está no ar!");
});

// ===================================================================
// ROTA PRINCIPAL QUE RECEBE O WEBHOOK DA OLX
// ===================================================================
app.post("/", async (req, res) => {
  console.log("✅ Webhook da OLX recebido!");

  if (operatorIds.length === 0) {
    console.error("❌ ERRO CRÍTICO: Nenhum ID de operador configurado na variável de ambiente OPERATOR_IDS.");
    return res.status(500).json({ error: "Nenhum operador configurado para receber leads." });
  }

  const { name: leadName, phoneNumber, clientListingId: propertyCode } = req.body;
  if (!leadName || !phoneNumber || !propertyCode) {
    console.error("❌ Erro: Dados essenciais (nome, telefone ou código do imóvel) ausentes no webhook.");
    return res.status(400).json({ error: "Dados essenciais do lead ausentes." });
  }
  const leadPhone = phoneNumber.replace(/\D/g, '');

  try {
    const selectedOperatorId = operatorIds[Math.floor(Math.random() * operatorIds.length)];
    console.log(`Lead de ${leadName} será atribuído ao operador com ID: ${selectedOperatorId}`);

    const contatoId = await findOrCreateContact(leadName, leadPhone, propertyCode);
    console.log(`Contato processado. ID do Contato: ${contatoId}`);

    await assignContactToOperator(contatoId, selectedOperatorId);
    console.log(`Contato ${contatoId} atribuído ao operador ${selectedOperatorId}.`);

    const chatId = await openChat(contatoId);
    console.log(`Chat aberto para o contato ${contatoId}. ID do Chat: ${chatId}`);

    await sendTemplateMessage(chatId, leadName);
    console.log(`Template enviado para o chat ${chatId}.`);

    console.log("✅ Fluxo completo executado com sucesso!");
    res.status(200).json({ status: "Lead recebido e processado com sucesso." });

  } catch (error) {
    console.error("❌ Erro durante o fluxo de processamento do lead no Poli:", error.message);
    res.status(500).json({ status: "Erro interno ao processar o lead." });
  }
});

// ===================================================================
// FUNÇÕES AUXILIARES PARA INTERAGIR COM A API DO POLI DIGITAL
// ===================================================================

async function findOrCreateContact(name, phone, propertyCode) {
  try {
    const response = await axios.get(`${BASE_URL}/chats/contato/numero/${phone}`, { headers: API_HEADERS });
    console.log("Contato já existente encontrado.");
    return response.data.id;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log("Contato não encontrado. Criando um novo...");
      const newContactPayload = {
        nome: name,
        numero: phone,
        cpf: propertyCode,
      };
      const response = await axios.post(`${BASE_URL}/contatos`, newContactPayload, { headers: API_HEADERS });
      return response.data.id;
    }
    throw new Error(`Erro ao buscar ou criar contato: ${error.message}`);
  }
}

async function assignContactToOperator(contactId, operatorId) {
  const payload = { atendenteId: operatorId };
  await axios.put(`${BASE_URL}/chats/contato/${contactId}/atendente`, payload, { headers: API_HEADERS });
  return true;
}

async function openChat(contactId) {
  const response = await axios.post(`${BASE_URL}/chats/contato/${contactId}/abrir`, null, { headers: API_HEADERS });
  return response.data.id;
}

async function sendTemplateMessage(chatId, contactName) {
  const payload = {
    template: "abordagem2",
    parametros: [contactName],
  };
  await axios.post(`${BASE_-URL}/chats/${chatId}/template`, payload, { headers: API_HEADERS });
  return true;
}

// Inicia o servidor
const PORT = process.env.PORT || 3000;

// ===================================================================
// LINHA ALTERADA - Adicionamos '0.0.0.0'
// ===================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
