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
const OFF_HOURS_TEMPLATE_ID = process.env.OFF_HOURS_TEMPLATE_ID || null;
const OPERATOR_NAMES_MAP = process.env.OPERATOR_NAMES_MAP;

const BASE_URL = "https://app.polichat.com.br/api/v1";
const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 10000);
const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 10 * 60 * 1000); // 10min
const SEND_COOLDOWN_MS = Number(process.env.SEND_COOLDOWN_MS || 30 * 60 * 1000);     // 30min
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

const START_HOUR = Number(process.env.START_HOUR || 9);  // início da janela (inclusivo)
const END_HOUR   = Number(process.env.END_HOUR   || 21); // fim da janela (inclusivo)
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
  if (/^[A-Z]{2,4}$/.test(part)) return part; // preserva siglas curtas tipo SP/USA
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
  // Para logging legível:
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  // Para regras:
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false });
  const dowFmt  = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });

  const partsHour = hourFmt.formatToParts(d);
  const hh = Number(partsHour.find(p => p.type === "hour")?.value || "0");

  const weekMap = { "Sun":0, "Mon":1, "Tue":2, "Wed":3, "Thu":4, "Fri":5, "Sat":6 };
  const dow = weekMap[dowFmt.format(d)] ?? 0;

  return { date: d, hh, dow, fmtStr: fmt.format(d) };
}

function selectTemplateForNow() {
  const { hh } = nowInTimezone(TIMEZONE);
  const dentroHorario = hh >= START_HOUR && hh <= END_HOUR;
  const chosenTemplate = dentroHorario ? TEMPLATE_ID : (OFF_HOURS_TEMPLATE_ID || TEMPLATE_ID);
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
const recentLeads = new Map(); // key: phone:property -> { ts, status }
const recentSends = new Map(); // key: contactId:templateId -> { ts }

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

  const { name, email, phoneDigits, propertyCode, originLeadId } = normalizeLeadPayload(req.body);
  if (!name || !phoneDigits || !propertyCode) {
    return res.status(400).json({ error: "Dados essenciais do lead ausentes." });
  }

  // Log de horário e template escolhido
  const { fmtStr, dow, hh } = (() => {
    const n = nowInTimezone(TIMEZONE);
    return { fmtStr: n.fmtStr, dow: n.dow, hh: n.hh };
  })();
  const sel = selectTemplateForNow();
  console.log(
    `[${requestId}] Lead:`,
    JSON.stringify({
      name,
      email,
      phone: maskPhone(phoneDigits),
      listing: propertyCode,
      originLeadId
    })
  );
  console.log(
    `[${requestId}] Agora: ${fmtStr} | DOW=${dow} (0=Dom..6=Sáb) | janela=${String(START_HOUR).padStart(2,"0")}:00-${String(END_HOUR).padStart(2,"0")}:00 ${TIMEZONE} | dentroHorario=${sel.dentroHorario} | template=${sel.chosenTemplate}`
  );

  // -------- Idempotência do LEAD (phone+property) --------
  const idemKey = `${phoneDigits}:${propertyCode}`;
  const now = Date.now();
  const seen = recentLeads.get(idemKey);
  if (seen) {
    if (seen.status === "done" && now - seen.ts < IDEMPOTENCY_TTL_MS) {
      console.log(`[${requestId}] 🔁 Duplicado recente (lead) — ignorado.`);
      return res.status(200).json({ status: "Lead ignorado (duplicado recente)." });
    }
    if (seen.status === "inflight") {
      console.log(`[${requestId}] ⏳ Lead já em processamento — 202.`);
      return res.status(202).json({ status: "Lead em processamento." });
    }
  }
  recentLeads.set(idemKey, { ts: now, status: "inflight" });

  try {
    // 1) Contato (já com nome normalizado; inclui cpf/email quando disponíveis)
    const contactId = await ensureContactExists(name, phoneDigits, requestId, { email, propertyCode });
    console.log(`[${requestId}] Contato processado. ID: ${contactId}`);

    // 2) Detalhes do contato
    let contactDetails = await getContactDetails(contactId, requestId);
    if (!contactDetails || typeof contactDetails !== "object") {
      throw new Error("Resposta de detalhes do contato vazia ou inválida.");
    }

    // 3) Ajustes de dados (nome/cpf/email) se necessário
    const desiredName = NAME_NORMALIZE_ENABLED ? toTitleCasePtBr(name) : name;
    const needName = NAME_NORMALIZE_ENABLED && needNameUpdate(contactDetails?.name || "", desiredName);
    const needCpf  = (contactDetails?.cpf || "") !== String(propertyCode).padStart(11, "0");
    const needMail = !!email && (String(contactDetails?.email || "").toLowerCase() !== String(email).toLowerCase());

    if (needName || needCpf || needMail) {
      const fields = {};
      if (needName) fields.name = desiredName;
      if (needCpf)  fields.cpf  = String(propertyCode).padStart(11, "0");
      if (needMail) fields.email = email;

      console.log(
        `[${requestId}] Atualizando contato: ${JSON.stringify({
          needNameUpdate: !!needName,
          needCpfUpdate: !!needCpf,
          needEmailUpdate: !!needMail,
          fields
        })}`
      );
      await updateContactFields(contactId, fields, requestId);
      console.log(
        `[${requestId}] Contato atualizado via PUT. Campos: ${Object.keys(fields).join(", ")}`
      );
      contactDetails = await getContactDetails(contactId, requestId);
      console.log(
        `[${requestId}] Após update -> name: "${contactDetails?.name}", cpf: "${contactDetails?.cpf}", email: "${contactDetails?.email || ""}"`
      );
    } else {
      console.log(`[${requestId}] Sem necessidade de atualizar nome/cpf/email.`);
    }

    // 4) Operador
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

    // 5) Canal correto (ou forçado por env)
    const channelForSend = FORCE_CHANNEL_ID
      ? CHANNEL_ID
      : (contactDetails?.externals?.[0]?.channel_id ?? CHANNEL_ID);
    console.log(
      `[${requestId}] Canal para envio:`,
      JSON.stringify({ chosen: channelForSend, fallback: CHANNEL_ID, forced: FORCE_CHANNEL_ID })
    );

    // -------- Anti-REENVIO de TEMPLATE (por contato) --------
    const templateToSend = sel.chosenTemplate;
    const sendKey = `${contactId}:${templateToSend}`;
    const prev = recentSends.get(sendKey);
    if (prev && now - prev.ts < SEND_COOLDOWN_MS) {
      const msLeft = SEND_COOLDOWN_MS - (now - prev.ts);
      console.log(
        `[${requestId}] 🚫 Anti-reenvio: template ${templateToSend} já enviado para contato ${contactId} há ${Math.round((now - prev.ts)/1000)}s; faltam ~${Math.round(msLeft/1000)}s para liberar.`
      );
      recentLeads.set(idemKey, { ts: Date.now(), status: "done" });
      return res.status(200).json({ status: "Envio suprimido por cooldown de template." });
    }

    // 6) Envio do template
    const audit = await sendTemplateMessage(
      contactId,
      assignedOperatorId,
      desiredName,
      operatorName,
      channelForSend,
      templateToSend,
      requestId
    );
    console.log(`[${requestId}] Template enviado com sucesso.`, JSON.stringify(audit));

    // marca cooldown
    recentSends.set(sendKey, { ts: Date.now() });
    // fecha idempotência do lead
    recentLeads.set(idemKey, { ts: Date.now(), status: "done" });

    console.log(`[${requestId}] ✅ Fluxo completo executado com sucesso!`);
    return res.status(200).json({ status: "Lead recebido e processado com sucesso." });
  } catch (error) {
    recentLeads.delete(idemKey);
    const errorMsg =
      error?.response?.data
        ? JSON.stringify(error.response.data)
        : error?.message || String(error);
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

async function updateContactFields(contactId, fields = {}, reqId) {
  if (!fields || !Object.keys(fields).length) return;

  const url = `/customers/${CUSTOMER_ID}/contacts/${contactId}`;

  // 1) Tenta JSON
  try {
    const resp = await putWithRetry(
      url,
      fields,
      { headers: API_HEADERS_JSON },
      reqId,
      "update_contact_json"
    );
    console.log(
      `[${reqId}] Contato atualizado via PUT (JSON). Campos: ${Object.keys(fields).join(", ")}`
    );
    return resp?.data;
  } catch (err) {
    const st = err?.response?.status;
    // 2) Fallback para x-www-form-urlencoded se o servidor rejeitar JSON
    if ([400, 401, 403, 404, 409, 415, 422].includes(Number(st))) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null) form.append(k, String(v));
      }
      try {
        const resp = await putWithRetry(
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
          "update_contact_form"
        );
        console.log(
          `[${reqId}] Contato atualizado via PUT (FORM). Campos: ${Object.keys(fields).join(", ")}`
        );
        return resp?.data;
      } catch (err2) {
        console.error(
          `[${reqId}] Falha ao atualizar contato (FORM)`,
          "status:", err2?.response?.status,
          "data:", JSON.stringify(err2?.response?.data || {})
        );
        throw err2;
      }
    } else {
      console.error(
        `[${reqId}] Falha ao atualizar contato (JSON)`,
        "status:", err?.response?.status,
        "data:", JSON.stringify(err?.response?.data || {})
      );
      throw err;
    }
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
process.on("uncaughtException", (err) => console.error("UNCAUGHT", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED", err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
