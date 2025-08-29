// ... (todo o início do código é o mesmo) ...

// ===================================================================
// FUNÇÕES AUXILIARES PARA INTERAGIR COM A API DO POLI DIGITAL
// ===================================================================

async function ensureContactExists(name, phone, propertyCode) {
  const url = `${BASE_URL}/customers/${CUSTOMER_ID}/contacts`;
  const payload = { name: name, phone: phone, cpf: propertyCode };
  try {
    const response = await axios.post(url, payload, { headers: API_HEADERS });
    
    // LINHA DE DIAGNÓSTICO ADICIONADA
    console.log("Resposta completa da criação de contato:", JSON.stringify(response.data, null, 2));

    console.log("Novo contato criado.");
    return response.data.id; // Esta linha ainda está "errada", mas vamos corrigi-la no próximo passo
  } catch(error) {
    if(error.response && error.response.data && error.response.data.id){
       console.log("Contato já existente. Usando ID retornado.");
       return error.response.data.id;
    }
    throw error;
  }
}

// ... (o resto do código continua exatamente o mesmo) ...
// (Para economizar espaço, não colei o arquivo inteiro, apenas a função alterada. 
// Por favor, adicione apenas a linha do console.log no seu arquivo existente)