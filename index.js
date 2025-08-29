import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config();
const app = express();
app.use(express.json());

// ================== CONFIG ==================
const POLI_API_TOKEN = process.env.POLI_API_TOKEN;
const CUSTOMER_ID = process.env.CUSTOMER_ID;
const CHANNEL_ID = Number(process.env.CHANNEL_ID); // fallback
const TEMPLATE_ID = process.env.TEMPLATE_ID;
const OPERATOR_NAMES_MAP = process.env.OPERATOR_NAMES_MAP;

const BASE_URL = "https://app.polichat.com.br/api/v1";
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 10000);
const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 10 * 60 * 1000); // 10min
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

const API_HEADERS_JSON = {
  Authorization: `Bearer ${POLI_API_TOKEN}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

// Axios com baseURL + timeout (sem logar token)
const http = axios.create({
  baseURL: BASE_URL,
  timeout: AXIOS_TIMEOUT_MS,
  headers: { Authorization: `Bearer ${POLI_API_TOKEN}`, Accept: "application/json" },
});

// ================== OPERADORES ==================
const operatorIds = (process.env.OPERATOR_IDS || "")
  .replace(/\s/g, "")
  .split(",")
  .filter(Boolean);

let operatorNamesMap = {};
try {
  operatorNamesMap = JSON.parse(OPERATOR_NAMES_MAP || "{}");
} catch (e) {
  console.error("ERRO CRÍTICO: Formato inválido em OPERATOR_NAMES_MAP. Deve ser JSON.", e);
}

// ================== UTILS ==================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function maskPhone(p) {
  const s = String(p || "");
  if (s.length <= 4) return s;
  const head = s.slice(0, 4);
  const tail = s.slice(-4);
  return `${head}${"*".repeat(Math.max(0, s.length - 8))}${tail}`;
}

function isRetryable(err) {
  const status = err?.response?.status;
  if (status >= 500 && status <= 599) return true;
  const code = err?.code;
  return ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"].includes(code);
}

async function postWithRetry(url, data, config, reqId, label) {
  let attempt = 0;
  let lastErr;
  const delays = [250, 1000, 4000]; // 250ms, 1s, 4s

  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      const resp = await http.post(url, data, config);
      return resp;
    } catch (err) {
      lastErr = err;
      const retry = isRetryable(err) && attempt < MAX_RETRIES;
      console.warn(
        `[${reqId}] POST fail (${label}) attempt ${attempt}/${MAX_RETRIES}`,
        "status:", err?.response?.status,
        "code:", err?.code,
        "retry:", retry
      );
      if (!retry) break;
      await sleep(delays[attempt - 1] || 4000);
    }
  }
  throw lastErr;
}

// Idempotência simples em memória (para 1 instância)
const recentLeads = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recentLeads.entries()) {
    if (!v || !v.ts || now - v.ts > IDEMPOTENCY_TTL_MS) recentLeads.delete(k);
  }
}, 60_000);

// ================== HEALTH ==================
app.get("/", (_req, res) => res.sendStatus(200));

// ================== WEBHOOK OLX ==================
app.post("/", async (req, res) => {
  const requestId = randomUUID();
  console.log(`[${requestId}] ✅ Webhook da OLX recebido!`);

  if (
    !operatorIds.length ||
    !CUSTOMER_ID ||
    !CHANNEL_ID ||
    !TEMPLATE_ID ||
    !Object.keys(operatorNamesMap).length
  ) {
    console.error(
      `[${requestId}] ❌ ERRO CRÍTICO: Variáveis de ambiente ausentes: ` +
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

  const { name: leadName, phoneNumber, clientListingId: propertyCode } = req.body || {};
  if (!leadName || !phoneNumber || !propertyCode) {
    return res.status(400).json({ error: "Dados essenciais do lead ausentes." });
  }

  const leadPhone = String(phoneNumber).replace(/\D/g, "");
  console.log(
    `[${requestId}] Lead:`,
    JSON.stringify({ name: leadName, phone: maskPhone(leadPhone), listing: propertyCode })
  );

  // Idempotência: evita duplicados recentes do mesmo imóvel/telefone
  const idemKey = `${leadPhone}:${propertyCode}`;
  const now = Date.now();
  const seen = recentLeads.get(idemKey);
  if (seen) {
    if (seen.status === "done" && now - seen.ts < IDEMPOTENCY_TTL_MS) {
      console.log(`[${requestId}] 🔁 Duplicado recente — ignorado.`);
      return res.status(200).json({ status: "Lead ignorado (duplicado recente)." });
    }
    if (seen.status === "inflight") {
      console.log(`[${requestId}] ⏳ Já em processamento — devolvendo 202.`);
      return res.status(202).json({ status: "Lead em processamento." });
    }
  }
  recentLeads.set(idemKey, { ts: now, status: "inflight" });

  try {
    // 1) Contato
    const contactId = await ensureContactExists(leadName, leadPhone, requestId);
    console.log(`[${requestId}] Contato processado. ID: ${contactId}`);

    const contactDetails = await getContactDetails(contactId, requestId);
    if (!contactDetails || typeof contactDetails !== "object") {
      throw new Error("Resposta de detalhes do contato vazia ou inválida.");
    }

    // 2) Operador
    let assignedOperatorId = contactDetails.user_id || contactDetails.userId || null;

    if (assignedOperatorId) {
      console.log(`[${requestId}] Contato já atribuído ao operador ID: ${assignedOperatorId}.`);
    } else {
      console.log(`[${requestId}] Contato sem operador. Sorteando um novo...`);
      assignedOperatorId = Number(
        operatorIds[Math.floor(Math.random() * operatorIds.length)]
      );
      await assignContactToOperator(contactId, assignedOperatorId, requestId);
      console.log(
        `[${requestId}] Contato ${contactId} atribuído ao novo operador ${assignedOperatorId}.`
      );
    }

    const operatorName =
      operatorNamesMap[assignedOperatorId] || "um de nossos consultores";
    console.log(`[${requestId}] Nome do operador para o template: ${operatorName}`);

    // 3) Canal correto para envio (usa canal do contato, senão fallback)
    const channelForSend =
      contactDetails?.externals?.[0]?.channel_id ?? CHANNEL_ID;
    console.log(
      `[${requestId}] Canal para envio:`,
      JSON.stringify({ chosen: channelForSend, fallback: CHANNEL_ID })
    );

    // 4) Envio do template
    const audit = await sendTemplateMessage(
      contactId,
      assignedOperatorId,
      leadName,
      operatorName,
      channelForSend,
      requestId
    );
    console.log(`[${requestId}] Template enviado com sucesso.`, JSON.stringify(audit));

    recentLeads.set(idemKey, { ts: Date.now(), status: "done" });
    console.log(`[${requestId}] ✅ Fluxo completo executado com sucesso!`);
    return res.status(200).json({ status: "Lead recebido e processado com sucesso." });
  } catch (error) {
    recentLeads.delete(idemKey); // libera para nova tentativa
    const errorMsg =
      error?.response?.data
        ? JSON.stringify(error.response.data)
        : error?.message || String(error);
    console.error(`[${requestId}] ❌ Erro no fluxo:`, errorMsg);
    return res.status(500).json({ status: "Erro interno ao processar o lead." });
  }
});

// ================== FUNÇÕES ==================
async function ensureContactExists(name, phone, reqId) {
  const url = `/customers/${CUSTOMER_ID}/contacts`;
  const form = new URLSearchParams();
  form.append("name", name);
  form.append("phone", phone);

  try {
    const resp = await postWithRetry(
      url,
      form,
      {
        headers: {
          Authorization: `Bearer ${POLI_API_TOKEN}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      },
      reqId,
      "create_contact"
    );

    const id =
      resp?.data?.data?.id ??
      resp?.data?.id ??
      resp?.data?.contact?.id ??
      null;

    if (!id) {
      console.log(`[${reqId}] RAW criação de contato:`, JSON.stringify(resp.data));
      throw new Error("Criação de contato sem ID na resposta.");
    }
    console.log(`[${reqId}] Novo contato criado.`);
    return id;
  } catch (error) {
    const maybeId =
      error?.response?.data?.data?.id ??
      error?.response?.data?.id ??
      null;
    if (maybeId) {
      console.log(`[${reqId}] Contato já existente. Usando ID retornado: ${maybeId}`);
      return maybeId;
    }
    console.error(
      `[${reqId}] Falha ao criar/recuperar contato:`,
      "status:", error?.response?.status,
      "data:", JSON.stringify(error?.response?.data || {}),
      "message:", error?.message,
      "code:", error?.code
    );
    throw error;
  }
}

async function getContactDetails(contactId, reqId) {
  const url = `/customers/${CUSTOMER_ID}/contacts/${contactId}`;
  const response = await http.get(url, { headers: API_HEADERS_JSON });
  const body = response?.data ?? {};
  const resolved = body?.data ?? body ?? null;
  console.log(`[${reqId}] Detalhes do contato obtidos.`);
  return resolved;
}

async function assignContactToOperator(contactId, operatorId, reqId) {
  const url = `/customers/${CUSTOMER_ID}/contacts/redirect/contacts/${contactId}`;
  const payload = { user_id: operatorId };

  try {
    await postWithRetry(url, payload, { headers: API_HEADERS_JSON }, reqId, "redirect");
    return true;
  } catch (error) {
    console.error(
      `[${reqId}] Falha ao atribuir operador:`,
      "status:", error?.response?.status,
      "data:", JSON.stringify(error?.response?.data || {}),
      "message:", error?.message
    );
    throw error;
  }
}

async function sendTemplateMessage(
  contactId,
  userId,
  contactName,
  operatorName,
  channelId,
  reqId
) {
  const url = `/customers/${CUSTOMER_ID}/whatsapp/send_template/channels/${channelId}/contacts/${contactId}/users/${userId}`;
  const params = JSON.stringify([contactName, operatorName]);

  const form = new URLSearchParams();
  form.append("quick_message_id", TEMPLATE_ID);
  form.append("parameters", params);

  const resp = await postWithRetry(
    url,
    form,
    {
      headers: {
        Authorization: `Bearer ${POLI_API_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    },
    reqId,
    "send_template"
  );

  const body = resp?.data || {};
  console.log(`[${reqId}] Resposta do send_template:`, JSON.stringify(body));

  // Validação forte do retorno
  if (body?.success === false || body?.send === false) {
    throw new Error(`Template aceito mas não enviado (success/send=false): ${JSON.stringify(body)}`);
  }

  return {
    chat_id: body?.chat_id,
    message_uid: body?.message_uid,
    success: body?.success,
    send: body?.send,
    http_code: body?.http_code,
  };
}

// ================== STARTUP & SAFETY ==================
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT", err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
