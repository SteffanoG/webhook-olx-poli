import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config();
const app = express();
app.use(express.json());

// ================== CONFIGURAÇÃO DE AMBIENTE ==================
const POLI_CLIENT_TOKEN = process.env.POLI_CLIENT_TOKEN;
const POLI_RESELLER_TOKEN = process.env.POLI_RESELLER_TOKEN;
const CUSTOMER_ID = process.env.CUSTOMER_ID;
const CHANNEL_ID = Number(process.env.CHANNEL_ID); 

if (!POLI_CLIENT_TOKEN || !POLI_RESELLER_TOKEN) {
    console.error("❌ ERRO CRÍTICO: Faltam tokens no .env");
}

// ================== CONSTANTES GLOBAIS ==================
const START_HOUR = Number(process.env.START_HOUR || 9);
const END_HOUR   = Number(process.env.END_HOUR   || 20);
const TIMEZONE   = process.env.TIMEZONE || "America/Sao_Paulo";

const BASE_URL = "https://app.polichat.com.br/api/v1"; 
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 10000);
const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 600000); 
const SEND_COOLDOWN_MS = Number(process.env.SEND_COOLDOWN_MS || 1800000);     
const MAX_RETRIES = 3;
const FORCE_CHANNEL_ID = String(process.env.FORCE_CHANNEL_ID || "false").toLowerCase() === "true";

// ================== CONFIGURAÇÃO DE TEMPLATES ==================
const TEMPLATE_IDS_IN_HOURS = (process.env.TEMPLATE_ID_IN_HOURS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const OFF_HOURS_TEMPLATE_ID = process.env.OFF_HOURS_TEMPLATE_ID || null;

if (TEMPLATE_IDS_IN_HOURS.length === 0 && process.env.TEMPLATE_ID) {
    TEMPLATE_IDS_IN_HOURS.push(process.env.TEMPLATE_ID);
}

let operatorNamesMap = {};
try {
    operatorNamesMap = JSON.parse(process.env.OPERATOR_NAMES_MAP || "{}");
} catch (e) {
    console.error("❌ Erro ao ler OPERATOR_NAMES_MAP no .env");
}

// ================== CLIENTE HTTP ==================
const CLIENT_HEADERS = {
  Authorization: `Bearer ${POLI_CLIENT_TOKEN}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const httpClient = axios.create({
  baseURL: BASE_URL,
  timeout: AXIOS_TIMEOUT_MS,
  headers: CLIENT_HEADERS,
});

// ================== OPERADORES E ROTEAMENTO ==================
const operatorIds = (process.env.OPERATOR_IDS || "").replace(/\s/g, "").split(",").filter(Boolean);

const SOROCABA_PROPERTY_CODES = new Set((process.env.SOROCABA_PROPERTY_CODES || "").split(","));
const SOROCABA_OPERATOR_IDS = (process.env.SOROCABA_OPERATOR_IDS || "").split(",").filter(Boolean);

let generalRoundRobinIndex = 0;
let sorocabaRoundRobinIndex = 0;

// ========= LÓGICA DE STATUS (API REVENDEDOR) =========
async function getServiceAvailableOperatorIds() {
    const url = `https://labrev.polichat.com.br/user/company/${CUSTOMER_ID}`;
    const availableIds = new Set();
    
    const resellerHeaders = {
        Authorization: `Bearer ${POLI_RESELLER_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json"
    };
    
    try {
        const response = await axios.get(url, { headers: resellerHeaders, timeout: AXIOS_TIMEOUT_MS });
        
        if (response.data && Array.isArray(response.data.data)) {
            for (const user of response.data.data) {
                // A API retorna "avaliable_service" (com erro de digitação deles)
                if (user.avaliable_service === 1) {
                    availableIds.add(String(user.id));
                }
            }
        }
        return availableIds;
    } catch (error) {
        console.error("⚠️ Falha ao checar status online (API Revenda):", error.message);
        return availableIds;
    }
}

function getAllOperators() {
    return [...operatorIds].sort();
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

async function postWithRetry(url, data, config, reqId, label) {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      return await httpClient.post(url, data, config);
    } catch (err) {
      const status = err?.response?.status;
      const isRetryable = (status >= 500 && status <= 599) || ["ECONNRESET", "ETIMEDOUT"].includes(err?.code);
      if (!isRetryable || attempt >= MAX_RETRIES) throw err;
      await sleep(1000);
    }
  }
}

async function putWithRetry(url, data, config, reqId, label) {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      return await httpClient.put(url, data, config);
    } catch (err) {
      const status = err?.response?.status;
      const isRetryable = (status >= 500 && status <= 599) || ["ECONNRESET", "ETIMEDOUT"].includes(err?.code);
      if (!isRetryable || attempt >= MAX_RETRIES) throw err;
      await sleep(1000);
    }
  }
}

function toTitleCasePtBr(raw) {
  if (!raw || typeof raw !== "string") return raw;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;
  const NAME_NORMALIZE_EXCEPTIONS = (process.env.NAME_NORMALIZE_EXCEPTIONS || "da,de,do,das,dos,e").split(",");
  return cleaned.split(" ").map((w, i) => {
    const lower = w.toLowerCase();
    if (i > 0 && NAME_NORMALIZE_EXCEPTIONS.includes(lower)) return lower;
    if (w.includes("-")) return w.split("-").map(p => capitalizePart(p)).join("-");
    return capitalizePart(w);
  }).join(" ");
}

function capitalizePart(part) {
  if (!part) return part;
  if (/^[A-Z]{2,4}$/.test(part)) return part;
  if (part.includes("'")) return part.split("'").map(p => cap(p)).join("'");
  return cap(part);
}
function cap(s) { const lower = s.toLowerCase(); return lower.charAt(0).toUpperCase() + lower.slice(1); }

function nowInTimezone(tz) {
  const d = new Date();
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false });
  const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  const hh = Number(hourFmt.format(d));
  const weekMap = { "Sun":0, "Mon":1, "Tue":2, "Wed":3, "Thu":4, "Fri":5, "Sat":6 };
  const dow = weekMap[dowFmt.format(d)] ?? 0;
  return { date: d, hh, dow, fmtStr: new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "short", timeStyle: "medium" }).format(d) };
}

function selectTemplateForNow() {
  const { hh, dow } = nowInTimezone(TIMEZONE);
  let dentroHorario = false;

  if (dow >= 1 && dow <= 5) {
      if (hh >= START_HOUR && hh < 20) dentroHorario = true;
  } else if (dow === 6) {
      if (hh >= START_HOUR && hh < 13) dentroHorario = true;
  }

  let chosenTemplate;
  if (dentroHorario) {
      if (TEMPLATE_IDS_IN_HOURS.length > 0) {
          const tIndex = Math.floor(Math.random() * TEMPLATE_IDS_IN_HOURS.length);
          chosenTemplate = TEMPLATE_IDS_IN_HOURS[tIndex];
      } else { chosenTemplate = null; }
  } else { chosenTemplate = OFF_HOURS_TEMPLATE_ID; }
  return { dentroHorario, chosenTemplate };
}

function normalizeLeadPayload(body = {}) {
  const rawName = body.name || body.leadName;
  const email = body.email;
  const rawPhone = body.phoneNumber || body.phone;
  const phoneDigits = rawPhone ? String(rawPhone).replace(/\D/g, "") : null;
  const propertyCode = body.clientListingId || body.listing || body.cod;
  const originLeadId = body.originLeadId || body.leadId;
  const name = process.env.NAME_NORMALIZE_ENABLED !== "false" && rawName ? toTitleCasePtBr(rawName) : rawName;
  return { name, email, phoneDigits, propertyCode, originLeadId };
}

// ================== CACHE ==================
const recentLeads = new Map();
const recentSends = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recentLeads.entries()) { if (now - v.ts > IDEMPOTENCY_TTL_MS) recentLeads.delete(k); }
  for (const [k, v] of recentSends.entries()) { if (now - v.ts > SEND_COOLDOWN_MS) recentSends.delete(k); }
}, 60000);

// ================== WEBHOOK ==================
app.post("/", async (req, res) => {
  const requestId = randomUUID().substring(0, 8); // ID curto para o log

  const { name, email, phoneDigits, propertyCode } = normalizeLeadPayload(req.body);

  // === SILENCIADOR ===
  // Se não tem dados de lead (apenas ping da OLX), retorna 200 e não loga nada.
  if (!name || !phoneDigits || !propertyCode) {
    return res.status(200).send("OK");
  }
  
  const { fmtStr } = nowInTimezone(TIMEZONE);
  const sel = selectTemplateForNow();

  console.log(`\n[${requestId}] 🔔 NOVO LEAD: ${name} | Imóvel: ${propertyCode} | ${fmtStr}`);

  const idemKey = `${phoneDigits}:${propertyCode}`;
  if (recentLeads.has(idemKey)) {
      console.log(`[${requestId}] ♻️ Duplicado (ignorado).`);
      return res.status(200).json({ status: "Duplicado recente." });
  }
  recentLeads.set(idemKey, { ts: Date.now() });

  try {
    // 1. CRIAR CONTATO
    const contactId = await ensureContactExists(name, phoneDigits, requestId, { email, propertyCode });
    
    // 2. BUSCAR DETALHES (ver se tem dono)
    let contactDetails = await getContactDetails(contactId, requestId);
    let assignedOperatorId = contactDetails?.user_id || contactDetails?.userId || null;

    // 3. ATUALIZAR DADOS
    if (name && contactDetails?.name !== name) {
         await updateContactFields(contactId, { name }, requestId);
    }

    // 4. DISTRIBUIR
    if (!assignedOperatorId) {
      const isSorocaba = SOROCABA_PROPERTY_CODES.has(String(propertyCode));
      const allOps = getAllOperators();
      const onlineOps = await getServiceAvailableOperatorIds();

      let targetList = [];
      let queueName = "";
      
      // Define a lista base (Sorocaba ou Geral)
      if (isSorocaba) {
        queueName = "Sorocaba";
        // Tenta filtrar online. Se ninguém online, usa lista completa de Sorocaba
        const onlineSorocaba = SOROCABA_OPERATOR_IDS.filter(id => onlineOps.has(id));
        targetList = onlineSorocaba.length > 0 ? onlineSorocaba : SOROCABA_OPERATOR_IDS;
      } else {
        queueName = "Geral";
        // Tenta filtrar online. Se ninguém online, usa lista completa Geral
        const onlineGeral = allOps.filter(id => onlineOps.has(id));
        targetList = onlineGeral.length > 0 ? onlineGeral : allOps;
      }

      // LOG IMPORTANTE: Quem estava no "Pool" de sorteio
      const poolNames = targetList.map(id => operatorNamesMap[id] || id).join(", ");
      console.log(`[${requestId}] 👥 Pool de Distribuição (${queueName}): [${poolNames}]`);

      // Seleção Round-Robin
      let idx = 0;
      if (isSorocaba) {
          idx = sorocabaRoundRobinIndex % targetList.length;
          sorocabaRoundRobinIndex++;
      } else {
          idx = generalRoundRobinIndex % targetList.length;
          generalRoundRobinIndex++;
      }
      
      assignedOperatorId = Number(targetList[idx]);

      if (assignedOperatorId) {
        await assignContactToOperator(contactId, assignedOperatorId, requestId);
      }
    } else {
        const donoNome = operatorNamesMap[assignedOperatorId] || assignedOperatorId;
        console.log(`[${requestId}] 🔒 Contato já pertence a: ${donoNome}`);
    }

    // 5. ENVIAR MENSAGEM
    const operatorName = operatorNamesMap[assignedOperatorId] || "Consultor";
    const channelToSend = (contactDetails?.externals?.[0]?.channel_id) || CHANNEL_ID;

    const sendKey = `${contactId}:${sel.chosenTemplate}`;
    if (recentSends.has(sendKey) && Date.now() - recentSends.get(sendKey).ts < SEND_COOLDOWN_MS) {
       console.log(`[${requestId}] ⏳ Envio suprimido (Cooldown ativo).`);
       return res.status(200).json({ status: "Cooldown ativo." });
    }

    await sendTemplateMessage(contactId, assignedOperatorId, name, operatorName, channelToSend, sel.chosenTemplate, requestId);
    
    // LOG FINAL DE SUCESSO
    console.log(`[${requestId}] ✅ SUCESSO: Atribuído a ${operatorName} | Template Enviado: ${sel.chosenTemplate}`);
    
    recentSends.set(sendKey, { ts: Date.now() });
    return res.status(200).json({ status: "Sucesso" });

  } catch (error) {
    recentLeads.delete(idemKey);
    console.error(`[${requestId}] ❌ ERRO:`, error.response?.data || error.message);
    return res.status(500).json({ status: "Erro interno" });
  }
});

// ================== FUNÇÕES AUXILIARES ==================
async function ensureContactExists(name, phone, reqId, extras) {
  const url = `/customers/${CUSTOMER_ID}/contacts`;
  const form = new URLSearchParams();
  form.append("name", name);
  form.append("phone", phone);
  if (extras.email) form.append("email", extras.email);
  if (extras.propertyCode) form.append("cpf", String(extras.propertyCode).padStart(11, "0"));

  try {
    const res = await postWithRetry(url, form, { headers: { "Content-Type": "application/x-www-form-urlencoded" } }, reqId, "create");
    return res.data?.data?.id || res.data?.id;
  } catch (err) {
    const existingId = err.response?.data?.contact?.id;
    if (existingId) return existingId;
    throw err;
  }
}

async function getContactDetails(id, reqId) {
    const res = await httpClient.get(`/customers/${CUSTOMER_ID}/contacts/${id}`);
    return res.data?.data || res.data;
}

async function updateContactFields(id, fields, reqId) {
    await putWithRetry(`/customers/${CUSTOMER_ID}/contacts/${id}`, fields, {}, reqId, "update");
}

async function assignContactToOperator(contactId, userId, reqId) {
    await postWithRetry(`/customers/${CUSTOMER_ID}/contacts/redirect/contacts/${contactId}`, { user_id: userId }, {}, reqId, "assign");
}

async function sendTemplateMessage(contactId, userId, contactName, opName, channelId, templateId, reqId) {
    const params = JSON.stringify([contactName, opName]);
    const form = new URLSearchParams();
    form.append("quick_message_id", templateId);
    form.append("parameters", params);

    const res = await postWithRetry(
        `/customers/${CUSTOMER_ID}/whatsapp/send_template/channels/${channelId}/contacts/${contactId}/users/${userId}`,
        form,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        reqId, "send_msg"
    );
    return res.data;
}

// ================== START ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});