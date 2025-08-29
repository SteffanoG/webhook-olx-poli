import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import Redis from "ioredis";

dotenv.config();
const app = express();
app.use(express.json());

// =============== CONFIG GERAL ===============
const POLI_API_TOKEN = process.env.POLI_API_TOKEN;
const CUSTOMER_ID = process.env.CUSTOMER_ID;
const CHANNEL_ID = Number(process.env.CHANNEL_ID);   // fallback de canal
const TEMPLATE_ID = process.env.TEMPLATE_ID;
const OPERATOR_NAMES_MAP = process.env.OPERATOR_NAMES_MAP;

const BASE_URL = "https://app.polichat.com.br/api/v1";
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 10000);
const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 10 * 60 * 1000); // 10 min
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

// Redis (opcional) para distribuição justa e métricas
const REDIS_URL = process.env.REDIS_URL;
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

// Cabeçalhos padrão (NUNCA logar token)
const API_HEADERS_JSON = {
  Authorization: `Bearer ${POLI_API_TOKEN}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

// Axios com timeout e baseUrl
const http = axios.create({
  baseURL: BASE_URL,
  timeout: AXIOS_TIMEOUT_MS,
  headers: { Authorization: `Bearer ${POLI_API_TOKEN}`, Accept: "application/json" },
});

// =============== OPERADORES ===============
const operatorIds = (process.env.OPERATOR_IDS || "")
  .replace(/\s/g, "")
  .split(",")
  .filter(Boolean);

let operatorNamesMap = {};
try {
  operatorNamesMap = JSON.parse(OPERATOR_NAMES_MAP || "{}");
} catch (e) {
  console.error("ERRO CRÍTICO: OPERATOR_NAMES_MAP inválido (JSON).", e);
}

// =============== UTILITÁRIOS ===============
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAIR_SCOPE = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (diário)

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

// =============== BALANCEADOR JUSTO (Redis + fallback) ===============
let _memCounts = new Map(); // key: scope -> Map(opId -> count)
let _memPtr = new Map();    // key: scope -> rr pointer

async function pickOperatorFair(operators) {
  const ops = operators.map(String);
  const scope = FAIR_SCOPE();
  const zkey = `lead:quota:${CUSTOMER_ID}:${scope}`;
  const pkey = `lead:rrptr:${CUSTOMER_ID}:${scope}`;

  // --- Caminho Redis (preferencial)
  if (redis) {
    // garantir conjunto do dia
    const existing = new Set(await redis.zrange(zkey, 0, -1));
    const toAdd = [];
    for (const op of ops) if (!existing.has(op)) toAdd.push(0, op);
    if (toAdd.length) await redis.zadd(zkey, "NX", ...toAdd);

    // remover operadores que saíram
    const toRemove = [...existing].filter((op) => !ops.includes(op));
    if (toRemove.length) await redis.zrem(zkey, ...toRemove);

    // pegar menor score
    let first = await redis.zrange(zkey, 0, 0, "WITHSCORES"); // [member, score]
    if (!first || first.length < 2) {
      const init = [];
      for (const op of ops) init.push(0, op);
      if (init.length) await redis.zadd(zkey, "NX", ...init);
      first = await redis.zrange(zkey, 0, 0, "WITHSCORES");
    }
    const minScore = Number(first[1] || 0);
    const ties = await redis.zrangebyscore(zkey, minScore, minScore);

    const ptr = await redis.incr(pkey);
    const chosen = ties[(ptr - 1) % ties.length];

    await redis.zincrby(zkey, 1, chosen);
    await redis.expire(zkey, 60 * 60 * 48); // 48h
    await redis.expire(pkey, 60 * 60 * 48);

    return Number(chosen);
  }

  // --- Fallback memória (single instance)
  const mKey = `${CUSTOMER_ID}:${scope}`;
  if (!_memCounts.has(mKey)) _memCounts.set(mKey, new Map());
  const counts = _memCounts.get(mKey);

  for (const op of ops) if (!counts.has(op)) counts.set(op, 0);
  for (const op of [...counts.keys()]) if (!ops.includes(op)) counts.delete(op);

  const min = Math.min(...ops.map((op) => counts.get(op)));
  const ties = ops.filter((op) => counts.get(op) === min);
  const p = (_memPtr.get(mKey) || 0) + 1;
  _memPtr.set(mKey, p);
  const chosen = ties[(p - 1) % ties.length];
  counts.set(chosen, counts.get(chosen) + 1);
  return Number(chosen);
}

// Métrica de distribuição
app.get("/metrics/distribution", async (_req, res) => {
  try {
    const scope = FAIR_SCOPE();
    const zkey = `lead:quota:${CUSTOMER_ID}:${scope}`;
    if (!redis) {
      const mKey = `${CUSTOMER_ID}:${scope}`;
      const counts = Array.from((_memCounts.get(mKey) || new Map()).entries()).map(
        ([op, c]) => ({ user_id: Number(op), count: c })
      );
      return res.json({ scope, counts, source: "memory" });
    }
    const members = await redis.zrange(zkey, 0, -1, "WITHSCORES");
    const counts = [];
    for (let i = 0; i < members.length; i += 2) {
      counts.push({ user_id: Number(members[i]), count: Number(members[i + 1]) });
    }
    return res.json({ scope, counts, source: "redis" });
  } catch (e) {
    console.error("metrics error:", e.message);
    return res.status(500).json({ error: "metrics_failed" });
  }
});

// =============== HEALTH ===============
app.get("/", (_req, res) => res.sendStatus(200));

// =============== WEBHOOK OLX ===============
app.post("/", async (req, res) => {
  const requestId = randomUUID();
  console.log(`[${requestId}] ✅ Webhook OLX recebido.`);

  // Config mínima
  if (
    !operatorIds.length ||
    !CUSTOMER_ID ||
    !CHANNEL_ID ||
    !TEMPLATE_ID ||
    !Object.keys(operatorNamesMap).length
  ) {
    console.error(
      `[${requestId}] ❌ Config ausente`,
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
    console.log(`[${requestId}] Contato ID: ${contactId}`);

    const contactDetails = await getContactDetails(contactId, requestId);
    if (!contactDetails || typeof contactDetails !== "object") {
      throw new Error("contactDetails vazio/ inválido");
    }

    // 2) Operador (fair)
    let assignedOperatorId = contactDetails.user_id || contactDetails.userId || null;
    if (assignedOperatorId) {
      console.log(`[${requestId}] Já atribuído ao operador: ${assignedOperatorId}.`);
    } else {
      console.log(`[${requestId}] Selecionando operador (distribuição justa)...`);
      assignedOperatorId = await pickOperatorFair(operatorIds);
      await assignContactToOperator(contactId, assignedOperatorId, requestId);
      console.log(`[${requestId}] Atribuído (justo) ao operador: ${assignedOperatorId}.`);
    }
    const operatorName = operatorNamesMap[assignedOperatorId] || "um de nossos consultores";

    // 3) Canal correto para envio (usa canal do contato se existir)
    const channelForSend =
      contactDetails?.externals?.[0]?.channel_id ?? CHANNEL_ID;
    console.log(
      `[${requestId}] Canal para envio:`,
      JSON.stringify({ chosen: channelForSend, fallback: CHANNEL_ID })
    );

    // 4) Enviar template
    const audit = await sendTemplateMessage(
      contactId,
      assignedOperatorId,
      leadName,
      operatorName,
      channelForSend,
      requestId
    );
    console.log(`[${requestId}] Template OK`, JSON.stringify(audit));

    recentLeads.set(idemKey, { ts: Date.now(), status: "done" });
    console.log(`[${requestId}] ✅ Fluxo concluído.`);
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

// =============== FUNÇÕES AUXILIARES ===============

// Cria contato (form-urlencoded 'name' + 'phone') com retry/backoff
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
      console.log(`[${reqId}] RAW criação contato:`, JSON.stringify(resp.data));
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
      console.log(`[${reqId}] Contato existente. Usando ID: ${maybeId}`);
      return maybeId;
    }
    console.error(
      `[${reqId}] Falha criar/recuperar contato`,
      "status:", error?.response?.status,
      "data:", JSON.stringify(error?.response?.data || {}),
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
  console.log(`[${reqId}] Detalhes contato obtidos.`);
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
      `[${reqId}] Falha redirect`,
      "status:", error?.response?.status,
      "data:", JSON.stringify(error?.response?.data || {}),
      "message:", error?.message
    );
    throw error;
  }
}

async function sendTemplateMessage(contactId, userId, contactName, operatorName, channelId, reqId) {
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
  console.log(`[${reqId}] Resposta send_template:`, JSON.stringify(body));

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

// =============== STARTUP & SAFETY HOOKS ===============
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
