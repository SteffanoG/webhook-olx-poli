versão q funcionou 1 vez:
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
const API_HEADERS_JSON = {
  Authorization: Bearer ${POLI_API_TOKEN},
  "Content-Type": "application/json",
  Accept: "application/json",
};

// --- Lógica de Mapeamento e Distribuição de Atendentes ---
const operatorIds = (process.env.OPERATOR_IDS || "")
  .replace(/\s/g, "")
  .split(",")
  .filter(Boolean);

let operatorNamesMap = {};
try {
  operatorNamesMap = JSON.parse(OPERATOR_NAMES_MAP || "{}");
} catch (e) {
  console.error(
    "ERRO CRÍTICO: Formato inválido em OPERATOR_NAMES_MAP. Deve ser JSON.",
    e
  );
}

// Health Check
app.get("/", (_req, res) => res.sendStatus(200));

// ROTA PRINCIPAL (Webhook OLX)
app.post("/", async (req, res) => {
  console.log("✅ Webhook da OLX recebido!");
  // console.log("Body recebido:", JSON.stringify(req.body)); // habilite p/ depurar payload

  if (
    !operatorIds.length ||
    !CUSTOMER_ID ||
    !CHANNEL_ID ||
    !TEMPLATE_ID ||
    !Object.keys(operatorNamesMap).length
  ) {
    console.error(
      "❌ ERRO CRÍTICO: Variáveis de ambiente ausentes: " +
        JSON.stringify({
          hasOperatorIds: !!operatorIds.length,
          hasCUSTOMER_ID: !!CUSTOMER_ID,
          hasCHANNEL_ID: !!CHANNEL_ID,
          hasTEMPLATE_ID: !!TEMPLATE_ID,
          hasOperatorNamesMap: !!Object.keys(operatorNamesMap).length,
        })
    );
    return res.status(500).json({ error: "Erro de configuração do servidor." });
  }

  const {
    name: leadName,
    phoneNumber,
    clientListingId: propertyCode, // mantido para eventual uso futuro/log
  } = req.body || {};

  if (!leadName || !phoneNumber || !propertyCode) {
    return res.status(400).json({ error: "Dados essenciais do lead ausentes." });
  }

  // Telefone somente dígitos (E.164 sem '+')
  const leadPhone = String(phoneNumber).replace(/\D/g, "");

  try {
    const contactId = await ensureContactExists(leadName, leadPhone);
    console.log(Contato processado. ID: ${contactId});

    const contactDetails = await getContactDetails(contactId);
    if (!contactDetails || typeof contactDetails !== "object") {
      throw new Error(
        "Resposta de detalhes do contato vazia ou inválida (contactDetails null/undefined)."
      );
    }

    let assignedOperatorId =
      contactDetails.user_id || contactDetails.userId || null;

    if (assignedOperatorId) {
      console.log(Contato já atribuído ao operador ID: ${assignedOperatorId}.);
    } else {
      console.log("Contato sem operador. Sorteando um novo...");
      assignedOperatorId =
        operatorIds[Math.floor(Math.random() * operatorIds.length)];
      await assignContactToOperator(contactId, assignedOperatorId);
      console.log(
        Contato ${contactId} atribuído ao novo operador ${assignedOperatorId}.
      );
    }

    const operatorName =
      operatorNamesMap[assignedOperatorId] || "um de nossos consultores";
    console.log(Nome do operador para o template: ${operatorName});

    await sendTemplateMessage(
      contactId,
      assignedOperatorId,
      leadName,
      operatorName
    );
    console.log(Template enviado com sucesso para o contato ${contactId}.);

    console.log("✅ Fluxo completo executado com sucesso!");
    return res
      .status(200)
      .json({ status: "Lead recebido e processado com sucesso." });
  } catch (error) {
    const errorMsg =
      error?.response?.data
        ? JSON.stringify(error.response.data)
        : error?.message || String(error);
    console.error("❌ Erro no fluxo:", errorMsg);
    return res.status(500).json({ status: "Erro interno ao processar o lead." });
  }
});

// --------- FUNÇÕES AUXILIARES ---------

// Cria (ou reaproveita) contato usando x-www-form-urlencoded com 'name' e 'phone'
async function ensureContactExists(name, phone) {
  const url = ${BASE_URL}/customers/${CUSTOMER_ID}/contacts;

  // A API da sua conta aceitou 'phone' via form-urlencoded.
  const form = new URLSearchParams();
  form.append("name", name);
  form.append("phone", phone);

  try {
    const resp = await axios.post(url, form, {
      headers: {
        Authorization: Bearer ${POLI_API_TOKEN},
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    });

    const id =
      resp?.data?.data?.id ??
      resp?.data?.id ??
      resp?.data?.contact?.id ??
      null;

    if (!id) {
      console.log("RAW criação de contato:", JSON.stringify(resp.data));
      throw new Error("Criação de contato sem ID na resposta.");
    }
    console.log("Novo contato criado.");
    return id;
  } catch (error) {
    // Quando já existe, algumas APIs retornam erro com o ID do contato existente.
    const maybeId =
      error?.response?.data?.data?.id ??
      error?.response?.data?.id ??
      null;
    if (maybeId) {
      console.log("Contato já existente. Usando ID retornado:", maybeId);
      return maybeId;
    }
    // Log adicional p/ diagnosticar
    console.error(
      "Falha ao criar/recuperar contato:",
      error?.response?.status,
      JSON.stringify(error?.response?.data || {}),
      "message:",
      error?.message,
      "code:",
      error?.code
    );
    throw error;
  }
}

async function getContactDetails(contactId) {
  const url = ${BASE_URL}/customers/${CUSTOMER_ID}/contacts/${contactId};
  const response = await axios.get(url, { headers: API_HEADERS_JSON });
  // Algumas respostas podem vir como { data: {...} } ou { data: { data: {...} } }
  const body = response?.data ?? {};
  return body?.data ?? body ?? null;
}

async function assignContactToOperator(contactId, operatorId) {
  const url = ${BASE_URL}/customers/${CUSTOMER_ID}/contacts/redirect/contacts/${contactId};
  const payload = { user_id: operatorId };

  try {
    await axios.post(url, payload, { headers: API_HEADERS_JSON });
    return true;
  } catch (error) {
    console.error(
      "Falha ao atribuir operador:",
      error?.response?.status,
      JSON.stringify(error?.response?.data || {}),
      "message:",
      error?.message
    );
    throw error;
  }
}

async function sendTemplateMessage(contactId, userId, contactName, operatorName) {
  // userId no path, conforme validado em teste
  const url = ${BASE_URL}/customers/${CUSTOMER_ID}/whatsapp/send_template/channels/${CHANNEL_ID}/contacts/${contactId}/users/${userId};

  // parâmetros: array JSON stringificado [nomeContato, nomeOperador]
  const params = JSON.stringify([contactName, operatorName]);

  const data = new URLSearchParams();
  data.append("quick_message_id", TEMPLATE_ID);
  data.append("parameters", params);

  try {
    await axios.post(url, data, {
      headers: {
        Authorization: Bearer ${POLI_API_TOKEN},
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    return true;
  } catch (error) {
    console.error(
      "Falha ao enviar template:",
      error?.response?.status,
      JSON.stringify(error?.response?.data || {}),
      "message:",
      error?.message
    );
    throw error;
  }
}

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(🚀 Servidor rodando na porta ${PORT});
});