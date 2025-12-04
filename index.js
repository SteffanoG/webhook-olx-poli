import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config();
const app = express();
app.use(express.json());

// ================== HEALTH CHECK (Essencial para o Railway) ==================
app.get("/", (req, res) => {
    res.status(200).send("Server is running!");
});

// ================== VALIDAÇÃO DE AMBIENTE ==================
const POLI_CLIENT_TOKEN = process.env.POLI_CLIENT_TOKEN;
const POLI_RESELLER_TOKEN = process.env.POLI_RESELLER_TOKEN;
const CUSTOMER_ID = process.env.CUSTOMER_ID;
const CHANNEL_ID = Number(process.env.CHANNEL_ID);

// Validação não-bloqueante para não derrubar o container imediatamente
if (!POLI_CLIENT_TOKEN || !POLI_RESELLER_TOKEN) {
    console.error("⚠️ AVISO CRÍTICO: Tokens de API não encontrados nas variáveis de ambiente.");
}

// ================== CONSTANTES GLOBAIS ==================
const START_HOUR = Number(process.env.START_HOUR || 9);
const END_HOUR   = Number(process.env.END_HOUR   || 20);
const TIMEZONE   = process.env.TIMEZONE || "America/Sao_Paulo";

// Configurações de Rede
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

const OPERATOR_NAMES_MAP = process.env.OPERATOR_NAMES_MAP ? JSON.parse(process.env.OPERATOR_NAMES_MAP) : {};

// ================== CLIENTE HTTP (API OPERACIONAL) ==================
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
        console.error("Falha ao buscar status na API de Revendedor:", error.message);
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

// Função de Retry para POST (Corrigida para aceitar config)
async function postWithRetry(url, data, config, reqId, label) {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      // Importante: passamos o 'config' aqui para permitir sobrescrever headers
      return await httpClient.post(url, data, config);
    } catch (err) {
      const status = err?.response?.status;
      const isRetryable = (status >= 500 && status <= 599) || ["ECONNRESET", "ETIMEDOUT"].includes(err?.code);
      console.warn(`[${reqId}] POST fail (${label}) ${attempt}/${MAX_RETRIES} status:${status}`);
      if (!isRetryable || attempt >= MAX_RETRIES) throw err;
      await sleep(1000);
    }
  }
}

// Função de Retry para PUT (Corrigida para aceitar config)
async function putWithRetry(url, data, config, reqId, label) {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      return await httpClient.put(url, data, config);
    } catch (err) {
      const status = err?.response?.status;
      const isRetryable = (status >= 500 && status <= 599) || ["ECONNRESET", "ETIMEDOUT"].includes(err?.code);
      console.warn(`[${reqId}] PUT fail (${label}) ${attempt}/${MAX_RETRIES} status:${status}`);
      if (!isRetryable || attempt >= MAX_RETRIES) throw err;
      await sleep(1000);
    }
  }
}

// ====== Normalizações ======
const NAME_NORMALIZE_ENABLED = String(process.env.NAME_NORMALIZE_ENABLED || "true").toLowerCase() !== "false";
const NAME_NORMALIZE_EXCEPTIONS = (process.env.NAME_NORMALIZE_EXCEPTIONS || "da,de,do,das,dos,e").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function toTitleCasePtBr(raw) {
  if (!raw || typeof raw !== "string") return raw;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;
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
function needNameUpdate(c, d) { if (!c || !d) return false; return c !== d; }

function nowInTimezone(tz) {
  const d = new Date();
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false });
  const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  const hh = Number(hourFmt.format(d));
  const weekMap = { "Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6 };
  const dow = weekMap[dowFmt.format(d)] ?? 0;
  return { date: d, hh, dow, fmtStr: new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "short", timeStyle: "medium" }).format(d) };
}

function selectTemplateForNow() {
  const { hh, dow } = nowInTimezone(TIMEZONE);
  let dentroHorario = false;

  // Regra de horário (usando a variável global START_HOUR)
  if (dow >= 1 && dow <= 5) {
      if (hh >= START_HOUR && hh < 20) dentroHorario = true;
  } else if (dow === 6) {
      if (hh >= START_HOUR && hh < 13) dentroHorario = true;
  }

  let chosenTemplate = OFF_HOURS_TEMPLATE_ID;
  if (dentroHorario) {
      if (TEMPLATE_IDS_IN_HOURS.length > 0) {
          const tIndex = Math.floor(Math.random() * TEMPLATE_IDS_IN_HOURS.length);
          chosenTemplate = TEMPLATE_IDS_IN_HOURS[tIndex];
      } else { chosenTemplate = null; }
  }
  return { dentroHorario, chosenTemplate };
}

function normalizeLeadPayload(body = {}) {
    const rawName = body.name || body.leadName;
    const email = body.email;
    const rawPhone = body.phoneNumber || body.phone;
    const phoneDigits = rawPhone ? String(rawPhone).replace(/\D/g, "") : null;
    
    // Tratamento mais robusto para propertyCode
    let propertyCode = body.clientListingId || body.listing || body.cod;
    // Se propertyCode vier como objeto ou undefined, tenta converter ou deixa nulo
    if (typeof propertyCode === 'object') propertyCode = null;
    
    const originLeadId = body.originLeadId || body.leadId;
    const name = NAME_NORMALIZE_ENABLED && rawName ? toTitleCasePtBr(rawName) : rawName;
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
  const requestId = randomUUID();
  console.log(`[${requestId}] ✅ Webhook recebido!`);

  const { name, email, phoneDigits, propertyCode, originLeadId } = normalizeLeadPayload(req.body);

  if (!name || !phoneDigits || !propertyCode) {
      return res.status(400).json({ error: "Dados incompletos." });
  }

  const sel = selectTemplateForNow();
  console.log(`[${requestId}] Lead: ${name} (${maskPhone(phoneDigits)}) - Imóvel: ${propertyCode}`);
  console.log(`[${requestId}] Horário: ${sel.dentroHorario ? 'Dentro' : 'Fora'} - Template: ${sel.chosenTemplate}`);

  const idemKey = `${phoneDigits}:${propertyCode}`;
  if (recentLeads.has(idemKey)) {
      return res.status(200).json({ status: "Duplicado recente ignorado." });
  }
  recentLeads.set(idemKey, { ts: Date.now() });

  try {
    // 1. Garantir contato (Form Data para funcionar na API antiga)
    const contactId = await ensureContactExists(name, phoneDigits, requestId, { email, propertyCode });
    
    // 2. Buscar detalhes (para ver se já tem dono)
    const contactDetails = await getContactDetails(contactId, requestId);
    let assignedOperatorId = contactDetails?.user_id || contactDetails?.userId || null;

    // 3. Atualizar dados se necessário
    const needsUpdate = !contactDetails?.email && email;
    if (needsUpdate) {
         await updateContactFields(contactId, { email }, requestId);
    }

    // 4. Distribuir se não tiver dono
    if (!assignedOperatorId) {
        const isSorocaba = SOROCABA_PROPERTY_CODES.has(String(propertyCode));
        const allOps = getAllOperators();
        
        // Busca status online (API Revendedor)
        const onlineOps = await getServiceAvailableOperatorIds();

        let targetList = [];
        
        if (isSorocaba) {
            console.log(`[${requestId}] 🏠 Fila Sorocaba.`);
            // Tenta achar alguém de Sorocaba online
            targetList = SOROCABA_OPERATOR_IDS.filter(id => onlineOps.has(id));
            if (targetList.length === 0) targetList = SOROCABA_OPERATOR_IDS; // Fallback
            
            const idx = sorocabaRoundRobinIndex % targetList.length;
            assignedOperatorId = Number(targetList[idx]);
            sorocabaRoundRobinIndex++;
        } else {
            console.log(`[${requestId}] 🏢 Fila Geral.`);
            // Tenta achar alguém da lista geral online
            targetList = allOps.filter(id => onlineOps.has(id));
            
            // Fallback: Se ninguém online, usa todos
            if (targetList.length === 0) {
                console.warn(`[${requestId}] ⚠️ Ninguém 'Disponível'. Usando lista completa.`);
                targetList = allOps;
            }

            const idx = generalRoundRobinIndex % targetList.length;
            assignedOperatorId = Number(targetList[idx]);
            generalRoundRobinIndex++;
        }

        if (assignedOperatorId) {
            console.log(`[${requestId}] 👉 Atribuindo para: ${operatorNamesMap[assignedOperatorId] || assignedOperatorId}`);
            await assignContactToOperator(contactId, assignedOperatorId, requestId);
        }
    } else {
        console.log(`[${requestId}] 🔒 Contato já pertence a: ${operatorNamesMap[assignedOperatorId] || assignedOperatorId}`);
    }

    // 5. Enviar Mensagem
    const operatorName = operatorNamesMap[assignedOperatorId] || "Consultor";
    // Usa o canal do contato se existir, senão o padrão
    const channelToSend = (contactDetails?.externals?.[0]?.channel_id) || CHANNEL_ID;
    
    // Verifica cooldown de envio
    const sendKey = `${contactId}:${sel.chosenTemplate}`;
    if (recentSends.has(sendKey) && Date.now() - recentSends.get(sendKey).ts < SEND_COOLDOWN_MS) {
        console.log(`[${requestId}] ⏳ Envio suprimido (cooldown).`);
        return res.status(200).json({ status: "Cooldown ativo." });
    }

    await sendTemplateMessage(contactId, assignedOperatorId, name, operatorName, channelToSend, sel.chosenTemplate, requestId);
    
    console.log(`[${requestId}] 🚀 Mensagem enviada com sucesso!`);
    recentSends.set(sendKey, { ts: Date.now() });
    return res.status(200).json({ status: "Sucesso" });

  } catch (error) {
    console.error(`[${requestId}] ❌ Erro:`, error.response?.data || error.message);
    // Não apagar do cache em caso de erro para evitar loops, a menos que seja crítico
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ================== FUNÇÕES AUXILIARES DE API ==================

// 1. Criar Contato (FORM DATA OBRIGATÓRIO)
async function ensureContactExists(name, phone, reqId, extras) {
    const form = new URLSearchParams();
    form.append("name", name);
    form.append("phone", phone);
    if (extras.email) form.append("email", extras.email);
    if (extras.propertyCode) form.append("cpf", String(extras.propertyCode).padStart(11, "0"));

    try {
        // Importante: Sobrescreve o header para Form Data
        const res = await postWithRetry(`/customers/${CUSTOMER_ID}/contacts`, form, {
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        }, reqId, "create_contact");
        
        return res.data?.data?.id || res.data?.id;
    } catch (err) {
        // Se já existe, tenta recuperar ID do erro
        const existingId = err.response?.data?.contact?.id;
        if (existingId) {
            console.log(`[${reqId}] Contato já existe: ${existingId}`);
            return existingId;
        }
        throw err;
    }
}

// 2. Detalhes (JSON)
async function getContactDetails(id, reqId) {
    const res = await httpClient.get(`/customers/${CUSTOMER_ID}/contacts/${id}`);
    return res.data?.data || res.data;
}

// 3. Atualizar (JSON)
async function updateContactFields(id, fields, reqId) {
    await putWithRetry(`/customers/${CUSTOMER_ID}/contacts/${id}`, fields, {}, reqId, "update");
}

// 4. Atribuir (JSON)
async function assignContactToOperator(contactId, userId, reqId) {
    await postWithRetry(`/customers/${CUSTOMER_ID}/contacts/redirect/contacts/${contactId}`, { user_id: userId }, {}, reqId, "assign");
}

// 5. Enviar Template (FORM DATA OBRIGATÓRIO)
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
    
    if (res.data?.success === false) throw new Error("API retornou sucesso: false");
    return res.data;
}

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});