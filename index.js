import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.get("/", (req, res) => {
  res.send("🚀 Servidor funcionando!");
});

app.use(express.json());

const BASE_URL = "https://app.polichat.com.br/api/v1";

// Função para enviar mensagem de template
async function sendTemplateMessage(phone, firstName, operatorName) {
  try {
    const response = await axios.post(
      `${BASE_URL}/customers/${process.env.CUSTOMER_ID}/whatsapp/send_template/channels/${process.env.CHANNEL_ID}/contacts/${phone}/users/${process.env.USER_ID}`,
      {
        template: "#abordagem2",
        language: { code: "pt_BR" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: firstName },
              { type: "text", text: operatorName },
            ],
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.POLI_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Mensagem enviada com sucesso:", response.data);
  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error.response?.data || error.message);
  }
}

// Rota de teste
app.post("/send", async (req, res) => {
  const { phone, firstName, operatorName } = req.body;

  if (!phone || !firstName || !operatorName) {
    return res.status(400).json({ error: "Campos obrigatórios: phone, firstName, operatorName" });
  }

  await sendTemplateMessage(phone, firstName, operatorName);
  res.json({ status: "Mensagem enviada (verifique logs)" });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
