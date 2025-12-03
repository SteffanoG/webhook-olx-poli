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

// CONFIGURAÇÃO DE TEMPLATES (ROTAÇÃO ALEATÓRIA)
const TEMPLATE_IDS_IN_HOURS = (process.env.TEMPLATE_ID_IN_HOURS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const OFF_HOURS_TEMPLATE_ID = process.env.OFF_HOURS_TEMPLATE_ID || null;

// Fallback de segurança para template
if (TEMPLATE_IDS_IN_HOURS.length === 0 && process.env.TEMPLATE_ID) {
    TEMPLATE_IDS_IN_HOURS.push(process.env.TEMPLATE_ID);
}

const OPERATOR_NAMES_MAP = process.env.OPERATOR_NAMES_MAP;

const BASE_URL = "https://app.polichat.com.br/api/v1"; // API OPERACIONAL
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 10000);
const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 10 * 60 * 1000); // 10min
const SEND_COOLDOWN_MS = Number(process.env.SEND_COOLDOWN_MS || 30 * 60 * 1000);     // 30min
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

const START_HOUR = Number(process.env.START_HOUR || 9);
const END_HOUR   = Number(process.env.END_HOUR   || 20);
const TIMEZONE   = process.env.TIMEZONE || "America/Sao_Paulo";
const FORCE_CHANNEL_ID = String(process.env.FORCE_CHANNEL_ID || "false").toLowerCase() === "true";

const API_HEADERS_JSON = {
  Authorization: `Bearer ${POLI_API_TOKEN}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const http = axios.create({
  baseURL: BASE_URL,
  timeout: AXIOS_TIMEOUT_MS,
  headers: { Authorization: `Bearer ${POLI_API_TOKEN}`, Accept: "application/json" },
});

// ================== OPERADORES E ROTEAMENTO ==================
// LISTA PRINCIPAL: Agora todos aqui são considerados disponíveis para a fila geral
const operatorIds = (process.env.OPERATOR_IDS || "").replace(/\s/g, "").split(",").filter(Boolean);

let operatorNamesMap = {};
try {
  operatorNamesMap = JSON.parse(OPERATOR_NAMES_MAP || "{}");
} catch (e) {
  console.error("ERRO CRÍTICO: Formato inválido em OPERATOR_NAMES_MAP. Deve ser JSON.", e);
}

// Lendo as regras de roteamento do ambiente
const SOROCABA_PROPERTY_CODES = new Set((process.env.SOROCABA_PROPERTY_CODES || "").split(","));
const SOROCABA_OPERATOR_IDS = (process.env.SOROCABA_OPERATOR_IDS || "").split(",").filter(Boolean);

// Contadores para filas (Round-Robin)
let generalRoundRobinIndex = 0;
let sorocabaRoundRobinIndex = 0;

// ========= LÓGICA DE VERIFICAÇÃO DE STATUS (API DE GESTÃO) =========
async function getServiceAvailableOperatorIds() {
    const url = `https://labrev.polichat.com.br/user/company/${CUSTOMER_ID}`;
    const availableIds = new Set();
    
    try {
        const response = await axios.get(url, { headers: API_HEADERS_JSON });

        console.log("[DIAGNÓSTICO] Resposta da API de Gestão (/user/company):");
        
        if (response.data && Array.isArray(response.data.data)) {
            for (const user of response.data.data) {
                if (user.available_service === 1) {
                    availableIds.add(String(user.id));
                }
            }
        }
        return availableIds;
    } catch (error) {
        console.error("Falha ao buscar status 'available_service' dos operadores:", error.message);
        if (error.response) {
            console.error("Resposta do erro da API de Gestão:", JSON.stringify(error.response.data));
        }
        return availableIds;
    }
}

// SIMPLIFICADO: Retorna todos os operadores da lista principal
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

function isRetryable(err) {
  const status = err?.response?.status;
  if (status >= 500 && status <= 599) return true;
  const code = err?.code;
  return ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"].includes(code);
}

async function postWithRetry(url, data, config, reqId, label) {
  let attempt = 0;
  let lastErr;
  const delays = [250, 1000, 4000];
  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      return await http.post(url, data, config);
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

async function putWithRetry(url, data, config, reqId, label) {
  let attempt = 0;
  let lastErr;
  const delays = [250, 1000, 4000];
  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      return await http.put(url, data, config);
    } catch (err) {
      lastErr = err;
      const retry = isRetryable(err) && attempt < MAX_RETRIES;
      console.warn(
        `[${reqId}] PUT fail (${label}) attempt ${attempt}/${MAX_RETRIES}`,
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

// ====== Nome - Normalização PT-BR ======
const NAME_NORMALIZE_ENABLED = String(process.env.NAME_NORMALIZE_ENABLED || "true").toLowerCase() !== "false";
const NAME_NORMALIZE_EXCEPTIONS = (process.env.NAME_NORMALIZE_EXCEPTIONS || "da,de,do,das,dos,e")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function toTitleCasePtBr(raw = "") {
  if (!raw || typeof raw !== "string") return raw;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;

  const words = cleaned.split(" ");
  const result = words.map((w, idx) => {
    const lower = w.toLowerCase();
    if (idx > 0 && idx < words.length - 1 && NAME_NORMALIZE_EXCEPTIONS.includes(lower)) {
      return lower;
    }
    if (w.includes("-")) {
      return w
        .split("-")
        .map(part => capitalizePart(part))
        .join("-");
    }
    return capitalizePart(w);
  });

  return result.join(" ");
}

function capitalizePart(part) {
  if (!part) return part;
  if (/^[A-Z]{2,4}$/.test(part)) return part;
  if (part.includes("'")) {
    return part
      .split("'")
      .map(p => cap(p))
      .join("'");
  }
  return cap(part);
}

function cap(s) {
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function needNameUpdate(current, desired) {
  if (!current || !desired) return false;
  if (current === desired) return false;
  const norm = (t) => t.replace(/\s+/g, " ").trim();
  const c = norm(current);
  const d = norm(desired);
  const isAllCaps = c === c.toUpperCase();
  const isAllLower = c === c.toLowerCase();
  return isAllCaps || isAllLower || c !== d;
}

// ====== Horário comercial / seleção de template ======
function nowInTimezone(tz) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false });
  const dowFmt  = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });

  const partsHour = hourFmt.formatToParts(d);
  const hh = Number(partsHour.find(p => p.type === "hour")?.value || "0");

  const weekMap = { "Sun":0, "Mon":1, "Tue":2, "Wed":3, "Thu":4, "Fri":5, "Sat":6 };
  const dow = weekMap[dowFmt.format(d)] ?? 0;

  return { date: d, hh, dow, fmtStr: fmt.format(d) };
}

function selectTemplateForNow() {
  const { hh, dow } = nowInTimezone(TIMEZONE);
  let dentroHorario = false;

  switch (dow) {
    case 0:
      dentroHorario = false;
      break;

    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      if (hh >= 9 && hh < 20) {
        dentroHorario = true;
      }
      break;

    case 6:
      if (hh >= 9 && hh < 13) {
        dentroHorario = true;
      }
      break;
  }

  // Lógica de Rotação de Template (ALEATÓRIA)
  let chosenTemplate;
  if (dentroHorario) {
      if (TEMPLATE_IDS_IN_HOURS.length > 0) {
          const tIndex = Math.floor(Math.random() * TEMPLATE_IDS_IN_HOURS.length);
          chosenTemplate = TEMPLATE_IDS_IN_HOURS[tIndex];
      } else {
          chosenTemplate = null; // Fallback
      }
  } else {
      chosenTemplate = OFF_HOURS_TEMPLATE_ID;
  }

  return { dentroHorario, chosenTemplate };
}

// ================== NORMALIZAÇÃO DO PAYLOAD (OLX) ==================
function normalizeLeadPayload(body = {}) {
  const rawName = body.name ?? body.leadName ?? null;
  const email = body.email ?? null;
  const rawPhone = body.phoneNumber ?? body.phone ?? null;
  const phoneDigits = rawPhone ? String(rawPhone).replace(/\D/g, "") : null;

  const propertyCode =
    body.clientListingId ?? body.listing ?? body.clientListingCode ?? body.cod ?? null;

  const originLeadId = body.originLeadId ?? body.leadId ?? null;

  const name = NAME_NORMALIZE_ENABLED && rawName ? toTitleCasePtBr(rawName) : rawName;

  return { name, email, phoneDigits, propertyCode, originLeadId };
}

// ================== ANTI-DUP / ANTI-REENVIO (IN-MEM) ==================
const recentLeads = new Map();
const recentSends = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recentLeads.entries()) {
    if (!v || !v.ts || now - v.ts > IDEMPOTENCY_TTL_MS) recentLeads.delete(k);
  }
  for (const [k, v] of recentSends.entries()) {
    if (!v || !v.ts || now - v.ts > SEND_COOLDOWN_MS) recentSends.delete(k);
  }
}, 60_000);

// ================== HEALTH ==================
app.get("/", (_req, res) => res.sendStatus(200));

// ================== WEBHOOK ==================
app.post("/", async (req, res) => {
  const requestId = randomUUID();
  console.log(`[${requestId}] ✅ Webhook da OLX recebido!`);

  if (!operatorIds.length || !CUSTOMER_ID || !CHANNEL_ID || !Object.keys(operatorNamesMap).length) {
    console.error(`[${requestId}] ❌ ERRO CRÍTICO: Variáveis de ambiente ausentes.`);
    return res.status(500).json({ error: "Erro de configuração do servidor." });
  }

  const { name, email, phoneDigits, propertyCode, originLeadId } = normalizeLeadPayload(req.body);
  if (!name || !phoneDigits || !propertyCode) {
    return res.status(400).json({ error: "Dados essenciais do lead ausentes." });
  }
  
  const leadEmail = email || "não informado";

  const { fmtStr, dow } = (() => { const n = nowInTimezone(TIMEZONE); return { fmtStr: n.fmtStr, dow: n.dow }; })();
  
  // Seleção do Template com Rotação Aleatória
  const sel = selectTemplateForNow();

  console.log(`[${requestId}] Lead:`, JSON.stringify({ name, email: leadEmail, phone: maskPhone(phoneDigits), listing: propertyCode, originLeadId }));
  console.log(`[${requestId}] Agora: ${fmtStr} | DOW=${dow} (0=Dom..6=Sáb) | dentroHorario=${sel.dentroHorario} | template=${sel.chosenTemplate}`);

  const idemKey = `${phoneDigits}:${propertyCode}`;
  const now = Date.now();
  const seen = recentLeads.get(idemKey);
  if (seen) {
      if (seen.status === "done" && now - seen.ts < IDEMPOTENCY_TTL_MS) { return res.status(200).json({ status: "Lead ignorado (duplicado recente)." }); }
      if (seen.status === "inflight") { return res.status(202).json({ status: "Lead em processamento." }); }
  }
  recentLeads.set(idemKey, { ts: now, status: "inflight" });

  try {
    const contactId = await ensureContactExists(name, phoneDigits, requestId, { email: leadEmail, propertyCode });
    let contactDetails = await getContactDetails(contactId, requestId);

    const desiredName = NAME_NORMALIZE_ENABLED ? toTitleCasePtBr(name) : name;
    const needName = NAME_NORMALIZE_ENABLED && needNameUpdate(contactDetails?.name || "", desiredName);
    const needCpf  = (contactDetails?.cpf || "") !== String(propertyCode).padStart(11, "0");
    const needMail = !!leadEmail && (String(contactDetails?.email || "").toLowerCase() !== String(leadEmail).toLowerCase());

    if (needName || needCpf || needMail) {
      const fields = {};
      if (needName) fields.name = desiredName;
      if (needCpf)  fields.cpf  = String(propertyCode).padStart(11, "0");
      if (needMail) fields.email = leadEmail;
      await updateContactFields(contactId, fields, requestId);
    }

    let assignedOperatorId = contactDetails.user_id || contactDetails.userId || null;
    if (!assignedOperatorId) {
      const isSorocabaLead = SOROCABA_PROPERTY_CODES.has(String(propertyCode));
      const allOperators = getAllOperators();
      const serviceAvailableOperators = await getServiceAvailableOperatorIds();

      if (isSorocabaLead) {
        console.log(`[${requestId}] Lead de Sorocaba detectado. Roteando para a fila especial.`);
        const operatorIndex = sorocabaRoundRobinIndex % SOROCABA_OPERATOR_IDS.length;
        assignedOperatorId = Number(SOROCABA_OPERATOR_IDS[operatorIndex]);
        sorocabaRoundRobinIndex++;
        console.log(`[${requestId}] Novo lead de Sorocaba atribuído ao operador ${assignedOperatorId} (${operatorNamesMap[assignedOperatorId] || 'Nome não encontrado'})`);

      } else {
        // LÓGICA SIMPLIFICADA: Verifica quem está 'Disponível' na API
        const trulyAvailableOperators = allOperators.filter(id => serviceAvailableOperators.has(id)).sort();
        console.log(`[${requestId}] Todos os Operadores (Lista Geral): [${allOperators.join(', ')}]`);
        console.log(`[${requestId}] Operadores com status 'Disponível': [${Array.from(serviceAvailableOperators).join(', ')}]`);
        
        let operatorsToChooseFrom;

        if (trulyAvailableOperators.length > 0) {
            operatorsToChooseFrom = trulyAvailableOperators;
        } else {
            console.warn(`[${requestId}] Nenhum operador 'Disponível'. Usando fallback para TODOS os operadores.`);
            operatorsToChooseFrom = allOperators;
        }

        if (operatorsToChooseFrom.length > 0) {
          const operatorIndex = generalRoundRobinIndex % operatorsToChooseFrom.length;
          assignedOperatorId = Number(operatorsToChooseFrom[operatorIndex]);
          generalRoundRobinIndex++;
          console.log(`[${requestId}] Novo lead geral atribuído ao operador ${assignedOperatorId} (${operatorNamesMap[assignedOperatorId] || 'Nome não encontrado'})`);
        }
      }
      
      if (assignedOperatorId) {
        await assignContactToOperator(contactId, assignedOperatorId, requestId);
      } else {
        console.warn(`[${requestId}] Nenhum operador pôde ser atribuído para o lead ${contactId}.`);
      }
    }

    const operatorName = operatorNamesMap[assignedOperatorId] || "um de nossos consultores";
    const channelForSend = FORCE_CHANNEL_ID ? CHANNEL_ID : (contactDetails?.externals?.[0]?.channel_id ?? CHANNEL_ID);
    const templateToSend = sel.chosenTemplate;

    const sendKey = `${contactId}:${templateToSend}`;
    if (recentSends.has(sendKey) && now - recentSends.get(sendKey).ts < SEND_COOLDOWN_MS) {
      recentLeads.set(idemKey, { ts: Date.now(), status: "done" });
      return res.status(200).json({ status: "Envio suprimido por cooldown de template." });
    }
    
    const audit = await sendTemplateMessage(contactId, assignedOperatorId, desiredName, operatorName, channelForSend, templateToSend, requestId);
    
    console.log(`[${requestId}] ✅ Template [${templateToSend}] enviado com sucesso para ${operatorName} (ID: ${assignedOperatorId}). Response:`, JSON.stringify(audit));

    recentSends.set(sendKey, { ts: Date.now() });
    recentLeads.set(idemKey, { ts: Date.now(), status: "done" });

    return res.status(200).json({ status: "Lead recebido e processado com sucesso." });
  } catch (error) {
    recentLeads.delete(idemKey);
    const errorMsg = error?.response?.data ? JSON.stringify(error.response.data) : error?.message || String(error);
    console.error(`[${requestId}] ❌ Erro no fluxo:`, errorMsg);
    return res.status(500).json({ status: "Erro interno ao processar o lead." });
  }
});

// ================== FUNÇÕES ==================
async function ensureContactExists(name, phoneDigits, reqId, extras = {}) {
  const url = `/customers/${CUSTOMER_ID}/contacts`;
  const form = new URLSearchParams();
  form.append("name", name);
  form.append("phone", phoneDigits);
  if (extras?.email) form.append("email", extras.email);
  if (extras?.propertyCode) form.append("cpf", String(extras.propertyCode).padStart(11, "0"));

  try {
    const resp = await postWithRetry(
      url, form,
      { headers: { Authorization: `Bearer ${POLI_API_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } },
      reqId, "create_contact"
    );
    const id = resp?.data?.data?.id ?? resp?.data?.id ?? resp?.data?.contact?.id ?? null;
    if (!id) throw new Error("Criação de contato sem ID na resposta.");
    return id;
  } catch (error) {
    const maybeId = error?.response?.data?.contact?.id ?? error?.response?.data?.data?.id ?? error?.response?.data?.id ?? null;
    if (maybeId) {
        console.log(`[${reqId}] Contato já existente encontrado com ID: ${maybeId}`);
        return maybeId;
    }
    throw error;
  }
}

async function getContactDetails(contactId, reqId) {
  const url = `/customers/${CUSTOMER_ID}/contacts/${contactId}`;
  const response = await http.get(url, { headers: API_HEADERS_JSON });
  return response?.data?.data ?? response?.data ?? null;
}

async function updateContactFields(contactId, fields = {}, reqId) {
  if (!fields || !Object.keys(fields).length) return;
  const url = `/customers/${CUSTOMER_ID}/contacts/${contactId}`;
  try {
    await putWithRetry(url, fields, { headers: API_HEADERS_JSON }, reqId, "update_contact_json");
  } catch (err) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    await putWithRetry(url, form, { headers: { Authorization: `Bearer ${POLI_API_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } }, reqId, "update_contact_form");
  }
}

async function assignContactToOperator(contactId, operatorId, reqId) {
  const url = `/customers/${CUSTOMER_ID}/contacts/redirect/contacts/${contactId}`;
  const payload = { user_id: operatorId };
  await postWithRetry(url, payload, { headers: API_HEADERS_JSON }, reqId, "redirect");
}

async function sendTemplateMessage(
  contactId,
  userId,
  contactName,
  operatorName,
  channelId,
  templateIdToUse,
  reqId
) {
  const url = `/customers/${CUSTOMER_ID}/whatsapp/send_template/channels/${channelId}/contacts/${contactId}/users/${userId}`;
  
  const params = JSON.stringify([contactName, operatorName]);
  const form = new URLSearchParams();
  form.append("quick_message_id", templateIdToUse);
  form.append("parameters", params);
  const resp = await postWithRetry(
    url,
    form,
    { headers: { Authorization: `Bearer ${POLI_API_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } },
    reqId, "send_template"
  );
  const body = resp?.data || {};
  if (body?.success === false || body?.send === false) {
    throw new Error(`Template aceito mas não enviado: ${JSON.stringify(body)}`);
  }
  return body;
}

// ================== STARTUP & SAFETY ==================
process.on("uncaughtException", (err) => console.error("UNCAUGHT", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED", err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});