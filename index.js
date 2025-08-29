import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

// --- Configurações da API do Poli Digital ---
const POLI_API_TOKEN = process.env.POLI_API_TOKEN;
const CUSTOMER_ID = process.env.CUSTOMER_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TEMPLATE_ID = process.env.TEMPLATE_ID;
const OPERATOR_NAMES_MAP = process.env.OPERATOR_NAMES_MAP;

const BASE_URL = "https://app.polichat.com.br/api/v1";
const API_HEADERS = { // Mantido para as outras chamadas de API
  Authorization: `Bearer ${POLI_API_TOKEN}`,
  "Content-Type": "application/json",
};

// --- Lógica de Mapeamento e Distribuição de Atendentes ---
const operatorIds = (process.env.OPERATOR_IDS || "").replace(/\s/g, '').split(',').filter(Boolean);
let operatorNamesMap = {};
try {
  operatorNamesMap = JSON.parse(OPERATOR_NAMES_MAP || "{}");
} catch (e) {
  console.error("ERRO CRÍTICO: Formato inválido na variável OPERATOR_NAMES_MAP. Deve ser um JSON.", e);
}

// Rota de Health Check
app.get("/", (req, res) => {
  res.sendStatus(200);
});


// ROTA PRINCIPAL QUE RECEBE O WEBHOOK DA OLX
app.post("/", async (req, res) => {
  console.log("✅ Webhook da OLX recebido!");

  if (!operatorIds || operatorIds.length === 0 || !CUSTOMER_ID || !CHANNEL_ID || !TEMPLATE_ID || Object.keys(operatorNamesMap).length === 0) {
    console.error("❌ ERRO CRÍTICO: Uma ou mais variáveis de ambiente essenciais não estão configuradas ou estão vazias.");
    return res.status(500).json({ error: "Erro de configuração do servidor." });
  }

  const { name: leadName, phoneNumber, clientListingId: propertyCode } = req.body;
  if (!leadName || !phoneNumber || !propertyCode) {
    return res.status(400).json({ error: "Dados essenciais do lead ausentes." });
  }
  const leadPhone = phoneNumber.replace(/\D/g, '');

  try {
    const contactId = await ensureContactExists(leadName, leadPhone, propertyCode);
    console.log(`Contato processado. ID: ${contactId}`);

    const contactDetails = await getContactDetails(contactId);
    let assignedOperatorId = contactDetails.user_id;

    if (assignedOperatorId) {
      console.log(`Contato já atribuído ao operador ID: ${assignedOperatorId}.`);
    } else {
      console.log("Contato sem operador. Sorteando um novo...");
      assignedOperatorId = operatorIds[Math.floor(Math.random() * operatorIds.length)];
      await assignContactToOperator(contactId, assignedOperatorId);
      console.log(`Contato ${contactId} atribuído ao novo operador ${assignedOperatorId}.`);
    }
    
    const operatorName = operatorNamesMap[assignedOperatorId] || "um de nossos consultores";
    console.log(`Nome do operador a ser usado no template: ${operatorName}`);
    
    await sendTemplateMessage(contactId, assignedOperatorId, leadName, operatorName);
    console.log(`Template enviado com sucesso para o contato ${contactId}.`);

    console.log("✅ Fluxo completo executado com sucesso!");
    res.status(200).json({ status: "Lead recebido e processado com sucesso." });

  } catch (error) {
    const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error("❌ Erro no fluxo:", errorMsg);
    res.status(500).json({ status: "Erro interno ao processar o lead." });
  }
});


// FUNÇÕES AUXILIARES


async function ensureContactExists(name, phone, propertyCode) {
  const url = `${BASE_URL}/customers/${CUSTOMER_ID}/contacts`;
  const payload = { name: name, phone: phone, cpf: propertyCode };
  try {
    const response = await axios.post(url, payload, { headers: API_HEADERS });
    console.log("Novo contato criado.");
    return response.data.data.id;
  } catch(error) {
    if(error.response && error.response.data && error.response.data.id){
       console.log("Contato já existente. Usando ID retornado.");
       return error.response.data.id;
    }
    throw error;
  }
}

async function getContactDetails(contactId) {
  const url = `${BASE_URL}/customers/${CUSTOMER_ID}/contacts/${contactId}`;
  const response = await axios.get(url, { headers: API_HEADERS });
  return response.data.data;
}

async function assignContactToOperator(contactId, operatorId) {
  const url = `${BASE_URL}/customers/${CUSTOMER_ID}/contacts/redirect/contacts/${contactId}`;
  const payload = { user_id: operatorId };
  await axios.post(url, payload, { headers: API_HEADERS });
  return true;
}

async function sendTemplateMessage(contactId, userId, contactName, operatorName) {
  const url = `${BASE_URL}/customers/${CUSTOMER_ID}/whatsapp/send_template/channels/${CHANNEL_ID}/contacts/${contactId}/users/${user_id}`;
  
  // 1. Prepara os parâmetros como uma string de um array JSON
  const params = JSON.stringify([contactName, operatorName]);
  
  // 2. Prepara os dados no formato x-www-form-urlencoded
  const data = new URLSearchParams();
  data.append('quick_message_id', TEMPLATE_ID);
  data.append('parameters', params);
  
  // 3. Prepara os headers com o Content-Type correto
  const formHeaders = {
    'Authorization': `Bearer ${POLI_API_TOKEN}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  await axios.post(url, data, { headers: formHeaders });
  return true;
}

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});