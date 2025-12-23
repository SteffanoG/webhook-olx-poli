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

const START_HOUR = Number(process.env.START_HOUR || 9);
const END_HOUR   = Number(process.env.END_HOUR   || 20);
const TIMEZONE   = process.env.TIMEZONE || "America/Sao_Paulo";
const BASE_URL   = "https://app.polichat.com.br/api/v1"; 

const TEMPLATE_IDS_IN_HOURS = (process.env.TEMPLATE_ID_IN_HOURS || "").split(",").map(s => s.trim()).filter(Boolean);
const OFF_HOURS_TEMPLATE_ID = process.env.OFF_HOURS_TEMPLATE_ID || null;

let operatorNamesMap = {};
try { operatorNamesMap = JSON.parse(process.env.OPERATOR_NAMES_MAP || "{}"); } catch (e) { console.error("❌ Erro no OPERATOR_NAMES_MAP"); }

const httpClient = axios.create({ baseURL: BASE_URL, timeout: Number(process.env.AXIOS_TIMEOUT_MS || 10000), headers: { Authorization: `Bearer ${POLI_CLIENT_TOKEN}`, Accept: "application/json", "Content-Type": "application/json" } });

// ================== OPERADORES E ROTEAMENTO ==================
const operatorIds = (process.env.OPERATOR_IDS || "").replace(/\s/g, "").split(",").filter(Boolean);
const SOROCABA_PROPERTY_CODES = new Set((process.env.SOROCABA_PROPERTY_CODES || "").split(","));
const SOROCABA_OPERATOR_IDS = (process.env.SOROCABA_OPERATOR_IDS || "").split(",").filter(Boolean);

let generalRoundRobinIndex = 0;
let sorocabaRoundRobinIndex = 0;

// ========= LÓGICA DE STATUS ONLINE =========
async function getServiceAvailableOperatorIds() {
    const url = `https://labrev.polichat.com.br/user/company/${CUSTOMER_ID}`;
    const availableIds = new Set();
    try {
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${POLI_RESELLER_TOKEN}` }, timeout: 5000 });
        if (response.data?.data) response.data.data.forEach(u => { if (u.avaliable_service === 1) availableIds.add(String(u.id)); });
        return availableIds;
    } catch (error) { return availableIds; }
}

// ================== UTILS ==================
function nowInTimezone(tz) {
  const d = new Date();
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false });
  const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  const hh = Number(hourFmt.format(d));
  const dow = { "Sun":0, "Mon":1, "Tue":2, "Wed":3, "Thu":4, "Fri":5, "Sat":6 }[dowFmt.format(d)] ?? 0;
  return { hh, dow, fmtStr: new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "short", timeStyle: "medium" }).format(d) };
}

function selectTemplateForNow() {
  const { hh, dow } = nowInTimezone(TIMEZONE);
  let dentroHorario = (dow >= 1 && dow <= 5 && hh >= START_HOUR && hh < 20) || (dow === 6 && hh >= START_HOUR && hh < 13);
  let chosen = dentroHorario ? TEMPLATE_IDS_IN_HOURS[Math.floor(Math.random() * TEMPLATE_IDS_IN_HOURS.length)] : OFF_HOURS_TEMPLATE_ID;
  return { dentroHorario, chosenTemplate: chosen };
}

function normalizeLeadPayload(body = {}) {
  const rawName = body.name || body.leadName;
  const phone = (body.phoneNumber || body.phone || "").replace(/\D/g, "");
  return { name: rawName, phoneDigits: phone, propertyCode: body.clientListingId || body.listing || body.cod };
}

// ================== ROTAS ==================

// ROTA DE HEALTHCHECK (ESSENCIAL PARA O RAILWAY)
app.get("/", (req, res) => {
  res.status(200).send("BW Integration Server Online 🚀");
});

// ROTA DE LEAD (WEBHOOK OLX)
app.post("/", async (req, res) => {
  // --- SILENCIADOR DE PINGS (Ignora se não houver nome e telefone) ---
  if (!req.body?.name && !req.body?.leadName && !req.body?.phone) return res.status(200).send("OK");

  const requestId = randomUUID().substring(0, 8);
  const { name, phoneDigits, propertyCode } = normalizeLeadPayload(req.body);
  const { fmtStr } = nowInTimezone(TIMEZONE);
  const sel = selectTemplateForNow();

  console.log(`\n[${requestId}] 🔔 LEAD: ${name} | Imóvel: ${propertyCode} | ${fmtStr}`);

  try {
    const contactId = await ensureContactExists(name, phoneDigits, requestId, { propertyCode });
    const contactDetails = await httpClient.get(`/customers/${CUSTOMER_ID}/contacts/${contactId}`).then(r => r.data?.data || r.data);
    let assignedOperatorId = contactDetails?.user_id || null;

    if (!assignedOperatorId) {
      const isSorocaba = SOROCABA_PROPERTY_CODES.has(String(propertyCode));
      const onlineOps = await getServiceAvailableOperatorIds();
      
      let targetList = isSorocaba ? SOROCABA_OPERATOR_IDS : operatorIds;
      const onlineInTarget = targetList.filter(id => onlineOps.has(id));
      const finalPool = onlineInTarget.length > 0 ? onlineInTarget : targetList;

      const poolStatus = finalPool.map(id => `${onlineOps.has(id) ? "🟢" : "⚪"} ${operatorNamesMap[id] || id}`).join(" | ");
      console.log(`[${requestId}] 👥 Pool (${isSorocaba ? 'Sorocaba' : 'Geral'}): [ ${poolStatus} ]`);

      let idx = isSorocaba ? sorocabaRoundRobinIndex++ % finalPool.length : generalRoundRobinIndex++ % finalPool.length;
      assignedOperatorId = Number(finalPool[idx]);

      await httpClient.post(`/customers/${CUSTOMER_ID}/contacts/redirect/contacts/${contactId}`, { user_id: assignedOperatorId });
    }

    const opName = operatorNamesMap[assignedOperatorId] || "Consultor";
    console.log(`[${requestId}] 🎯 Template: ${sel.chosenTemplate} | Horário: ${sel.dentroHorario ? 'Comercial' : 'Plantão'}`);

    await sendTemplateMessage(contactId, assignedOperatorId, name, opName, CHANNEL_ID, sel.chosenTemplate);
    
    console.log(`[${requestId}] ✅ SUCESSO: Atribuído a ${opName}`);
    return res.status(200).json({ status: "Sucesso" });

  } catch (error) {
    console.error(`[${requestId}] ❌ ERRO:`, error.response?.data || error.message);
    return res.status(500).json({ status: "Erro" });
  }
});

// ================== FUNÇÕES AUXILIARES ==================
async function ensureContactExists(name, phone, reqId, extras) {
  const form = new URLSearchParams({ name, phone });
  if (extras.propertyCode) form.append("cpf", String(extras.propertyCode).padStart(11, "0"));
  try {
    const res = await httpClient.post(`/customers/${CUSTOMER_ID}/contacts`, form, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    return res.data?.data?.id || res.data?.id;
  } catch (err) { return err.response?.data?.contact?.id || (function(){throw err})() }
}

async function sendTemplateMessage(contactId, userId, contactName, opName, channelId, templateId) {
    const form = new URLSearchParams({ quick_message_id: templateId, parameters: JSON.stringify([contactName, opName]) });
    return httpClient.post(`/customers/${CUSTOMER_ID}/whatsapp/send_template/channels/${channelId}/contacts/${contactId}/users/${userId}`, form, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
}

// PORTA DINÂMICA PARA RAILWAY
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Servidor BW rodando na porta ${PORT}`));