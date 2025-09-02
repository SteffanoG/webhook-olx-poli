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
const TEMPLATE_ID_IN_HOURS = process.env.TEMPLATE_ID_IN_HOURS || null;
const TEMPLATE_ID_OFF_HOURS = process.env.TEMPLATE_ID_OFF_HOURS || null;

const WORKING_TZ = process.env.WORKING_TZ || "America/Sao_Paulo";
const WORKING_START = process.env.WORKING_START || "08:00"; // legado (não usado se houver SCHEDULE_JSON)
const WORKING_END = process.env.WORKING_END || "21:00";     // legado (não usado se houver SCHEDULE_JSON)
const WORKING_SCHEDULE_JSON = process.env.WORKING_SCHEDULE_JSON || ""; // opcional
const DEBUG_FORCE_DATETIME = process.env.DEBUG_FORCE_DATETIME || null;

const OPERATOR_NAMES_MAP = process.env.OPERATOR_NAMES_MAP;

// Normalização de nomes
const NAME_NORMALIZATION_MODE = (process.env.NAME_NORMALIZATION_MODE || "TITLE").toUpperCase(); // TITLE|UPPER|LOWER
const NAME_STYLE_FOR_TEMPLATE = (process.env.NAME_STYLE_FOR_TEMPLATE || "CAPITALIZE").toUpperCase(); // CAPITALIZE|UPPER|LOWER

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

// CPF a partir do código do anúncio (somente dígitos; 11 dígitos com left-pad ou corte)
function cpfFromListingCode(code) {
  const digits = String(code || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length > 11) return digits.slice(-11);
  return digits.padStart(11, "0");
}

// ====== NOME: normalização para o CONTATO e 1º nome para template ======
const MINOR_WORDS = new Set(["da", "de", "do", "das", "dos", "e"]);
function normalizeTokenTitleCase(token, isFirst, locale = "pt-BR") {
  if (!token) return token;
  return token
    .split(/(-|')/g)
    .map((part, idx, all) => {
      if (part === "-" || part === "'") return part;
      const lower = part.toLocaleLowerCase(locale);
      if (!isFirst && all.length === 1 && MINOR_WORDS.has(lower)) return lower;
      return lower.charAt(0).toLocaleUpperCase(locale) + lower.slice(1);
    })
    .join("");
}
function normalizeFullName(name, mode = NAME_NORMALIZATION_MODE) {
  if (!name) return "Cliente";
  const locale = "pt-BR";
  const tokens = String(name).trim().replace(/\s+/g, " ").split(" ");
  if (mode === "UPPER") return tokens.join(" ").toLocaleUpperCase(locale);
  if (mode === "LOWER") return tokens.join(" ").toLocaleLowerCase(locale);
  return tokens.map((t, i) => normalizeTokenTitleCase(t, i === 0, locale)).join(" ");
}
function extractFirstName(fullName) {
  if (!fullName) return "Cliente";
  const cleaned = String(fullName).trim().replace(/\s+/g, " ");
  const [first = "Cliente"] = cleaned.split(" ");
  return first;
}
function formatFirstNameForTemplate(fullName, style = NAME_STYLE_FOR_TEMPLATE) {
  const locale = "pt-BR";
  const first = extractFirstName(fullName);
  if (style === "UPPER") return first.toLocaleUpperCase(locale);
  if (style === "LOWER") return first.toLocaleLowerCase(locale);
  return normalizeTokenTitleCase(first, true, locale);
}
function canonicalize(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// ====== E-MAIL: normalização/validação ======
function normalizeEmail(email) {
  if (!email) return null;
  const s = String(email).trim().toLowerCase();
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  return ok ? s : null;
}

// ====== HORÁRIOS: por dia da semana ======
// dayIndex: 0=Dom, 1=Seg, 2=Ter, 3=Qua, 4=Qui, 5=Sex, 6=Sáb
const DEFAULT_SCHEDULE = {
  1: { start: "09:00", end: "21:00" }, // Seg
  2: { start: "09:00", end: "21:00" }, // Ter
  3: { start: "09:00", end: "21:00" }, // Qua
  4: { start: "09:00", end: "21:00" }, // Qui
  5: { start: "09:00", end: "21:00" }, // Sex
  6: { start: "09:00", end: "13:00" }, // Sáb
  // 0 (Dom) = fechado
};

let WORKING_SCHEDULE = DEFAULT_SCHEDULE;
if (WORKING_SCHEDULE_JSON) {
  try {
    const parsed = JSON.parse(WORKING_SCHEDULE_JSON);
    if (parsed && typeof parsed === "object") {
      WORKING_SCHEDULE = parsed;
    }
  } catch (e) {
    console.warn("WORKING_SCHEDULE_JSON inválido. Usando DEFAULT_SCHEDULE.", e?.message);
  }
}

function minutesInTZ(tz) {
  const ref = DEBUG_FORCE_DATETIME ? new Date(DEBUG_FORCE_DATETIME) : new Date();
  const h = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(ref)
  );
  const m = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, minute: "2-digit" }).format(ref));
  return h * 60 + m;
}
function parseHm(s) {
  const [h, m = "0"] = String(s).split(":");
  return Number(h) * 60 + Number(m);
}
function dayOfWeekInTZ(tz) {
  const ref = DEBUG_FORCE_DATETIME ? new Date(DEBUG_FORCE_DATETIME) : new Date();
  const w = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(ref);
  const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
  return idx < 0 ? 0 : idx;
}
function isWithinBusinessSchedule(tz, schedule) {
  const dow = dayOfWeekInTZ(tz); // 0..6
  const conf = schedule[dow];
  if (!conf) return false; // fechado
  const nowMin = minutesInTZ(tz);
  const s = parseHm(conf.start);
  const e = parseHm(conf.end);
  if (s === e) return true;                 // aberto 24h
  if (s < e) return nowMin >= s && nowMin < e;  // janela normal
  return nowMin >= s || nowMin < e;             // janela virada
}
function nowStringPTBR(tz) {
  const ref = DEBUG_FORCE_DATETIME ? new Date(DEBUG_FORCE_DATETIME) : new Date();
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "short", timeStyle: "medium" }).format(ref);
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

  // ----- Extração resiliente do payload OLX -----
  const body = req.body || {};
  const rawName =
    body.name ||
    body.clientName ||
    body.contactName ||
    body.buyerName ||
    "Lead OLX";
  const phoneNumber =
    body.phoneNumber ||
    body.phone ||
    body.phone_number ||
    body.msisdn ||
    body.contact?.phone ||
    null;

  // E-mail por várias chaves comuns
  const rawEmail =
    body.email ||
    body.clientEmail ||
    body.contactEmail ||
    body.buyerEmail ||
    body.leadEmail ||
    body.contact?.email ||
    null;
  const normalizedEmail = normalizeEmail(rawEmail);

  // Cód. do anúncio
  const propertyCodeRaw =
    body.clientListingId ??
    body.originListingId ??
    body.listingId ??
    body.listing?.id ??
    body.code ??
    null;

  const propertyCode = propertyCodeRaw ? String(propertyCodeRaw).trim() : null;
  const cpfCode = cpfFromListingCode(propertyCode);
  const originLeadId = body.originLeadId || body.leadId || null;

  if (!phoneNumber || !propertyCode) {
    return res.status(400).json({
      error:
        "Dados essenciais ausentes. É necessário pelo menos phoneNumber e clientListingId/originListingId.",
    });
  }

  // Normaliza e extrai primeiro nome
  const normalizedName = normalizeFullName(rawName, NAME_NORMALIZATION_MODE);
  const firstNameParam = formatFirstNameForTemplate(normalizedName, NAME_STYLE_FOR_TEMPLATE);

  const leadPhone = String(phoneNumber).replace(/\D/g, "");
  console.log(
    `[${requestId}] Lead:`,
    JSON.stringify({
      name: normalizedName,
      email: normalizedEmail || null,
      phone: maskPhone(leadPhone),
      listing: propertyCode,
      cpfFromCode: cpfCode,
      originLeadId: originLeadId,
    })
  );

  // Idempotência (usa originLeadId quando houver)
  const idemKey = originLeadId ? `olx:${originLeadId}` : `${leadPhone}:${propertyCode}`;
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
    // 0) Decisão de template por DIA/horário
    const inHours = isWithinBusinessSchedule(WORKING_TZ, WORKING_SCHEDULE);
    const templateToUse = inHours
      ? (TEMPLATE_ID_IN_HOURS || TEMPLATE_ID)
      : (TEMPLATE_ID_OFF_HOURS || TEMPLATE_ID);

    // log da janela do dia corrente
    const dow = dayOfWeekInTZ(WORKING_TZ);
    const conf = WORKING_SCHEDULE[dow] || null;
    console.log(
      `[${requestId}] Agora: ${nowStringPTBR(WORKING_TZ)} | DOW=${dow} (0=Dom..6=Sáb) | janela=${conf ? conf.start + "-" + conf.end : "FECHADO"} ${WORKING_TZ} | dentroHorario=${inHours} | template=${templateToUse}`
    );

    // 1) Contato (nome normalizado, CPF do anúncio e e-mail)
    const contactId = await ensureContactExists(
      normalizedName,
      leadPhone,
      cpfCode,
      normalizedEmail,
      body,
      requestId
    );
    console.log(`[${requestId}] Contato processado. ID: ${contactId}`);

    // 1.1) Garante nome/CPF/e-mail persistidos (para contato preexistente)
    let contactDetails = await getContactDetails(contactId, requestId);
    if (!contactDetails || typeof contactDetails !== "object") {
      throw new Error("Resposta de detalhes do contato vazia ou inválida.");
    }
    const needNameUpdate = canonicalize(contactDetails.name) !== canonicalize(normalizedName);
    const needCpfUpdate = !!cpfCode && contactDetails.cpf !== cpfCode;
    const needEmailUpdate =
      !!normalizedEmail && String(contactDetails.email || "").toLowerCase() !== normalizedEmail;

    if (needNameUpdate || needCpfUpdate || needEmailUpdate) {
      const fields = {};
      if (needNameUpdate) fields.name = normalizedName;
      if (needCpfUpdate) fields.cpf = cpfCode;
      if (needEmailUpdate) fields.email = normalizedEmail;
      console.log(
        `[${requestId}] Atualizando contato:`,
        JSON.stringify({ needNameUpdate, needCpfUpdate, needEmailUpdate, fields })
      );
      await updateContactFields(contactId, fields, requestId);
      contactDetails = await getContactDetails(contactId, requestId);
      console.log(
        `[${requestId}] Após update -> name: "${contactDetails?.name}", cpf: "${contactDetails?.cpf || null}", email: "${contactDetails?.email || null}"`
      );
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

    // 3) Canal correto (usa canal do contato; fallback CHANNEL_ID)
    const channelForSend =
      contactDetails?.externals?.[0]?.channel_id ?? CHANNEL_ID;
    console.log(
      `[${requestId}] Canal para envio:`,
      JSON.stringify({ chosen: channelForSend, fallback: CHANNEL_ID })
    );

    // 4) Envio do template (1º nome já formatado)
    const audit = await sendTemplateMessage(
      contactId,
      assignedOperatorId,
      formatFirstNameForTemplate(normalizedName, NAME_STYLE_FOR_TEMPLATE),
      operatorName,
      channelForSend,
      templateToUse,
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
async function ensureContactExists(name, phone, cpfCode, email, rawPayload, reqId) {
  const url = `/customers/${CUSTOMER_ID}/contacts`;
  const form = new URLSearchParams();
  form.append("name", name);
  form.append("phone", phone);
  if (cpfCode) form.append("cpf", cpfCode);
  if (email) form.append("email", email);
  if (rawPayload && Object.keys(rawPayload).length) {
    form.append("data", JSON.stringify({ olx: rawPayload }));
  }

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
    console.log(`[${reqId}] Novo contato criado (nome/CPF/e-mail incluídos quando disponíveis).`);
    return id;
  } catch (error) {
    // >>> PATCH: reaproveita ID retornado no erro (403 "Contato já existe..."):
    const body = error?.response?.data || {};
    const maybeId =
      body?.data?.id ??
      body?.id ??
      body?.contact?.id ??           // caminho observado no 403 da sua conta
      body?.data?.contact?.id ??     // variação defensiva
      null;

    if (maybeId) {
      console.log(`[${reqId}] Contato já existente. Usando ID retornado: ${maybeId}`);
      return maybeId;
    }

    console.error(
      `[${reqId}] Falha ao criar/recuperar contato:`,
      "status:", error?.response?.status,
      "data:", JSON.stringify(body),
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

async function updateContactFields(contactId, fields, reqId) {
  const headers = {
    Authorization: `Bearer ${POLI_API_TOKEN}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }

  const urlPut = `/customers/${CUSTOMER_ID}/contacts/${contactId}`;
  try {
    await http.put(urlPut, form, { headers });
    console.log(`[${reqId}] Contato atualizado via PUT. Campos: ${Object.keys(fields).join(", ")}`);
    return true;
  } catch (e) {
    if (e?.response?.status !== 404) {
      console.warn(
        `[${reqId}] PUT update falhou (status=${e?.response?.status}). Tentando POST legacy...`
      );
    }
    const resp = await postWithRetry(
      urlPut,
      form,
      { headers },
      reqId,
      "update_contact_fallback"
    );
    console.log(
      `[${reqId}] Contato atualizado via POST (fallback). Campos: ${Object.keys(fields).join(", ")}`
    );
    return !!resp;
  }
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
  firstNameParam,
  operatorName,
  channelId,
  templateIdToUse,
  reqId
) {
  const url = `/customers/${CUSTOMER_ID}/whatsapp/send_template/channels/${channelId}/contacts/${contactId}/users/${userId}`;
  const params = JSON.stringify([firstNameParam, operatorName]);

  const form = new URLSearchParams();
  form.append("quick_message_id", templateIdToUse);
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
