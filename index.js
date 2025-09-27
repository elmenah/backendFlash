// Backend mínimo para crear orden de pago FLOW
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));
// Configura tus credenciales FLOW en un archivo .env
const API_KEY = process.env.FLOW_API_KEY;
const SECRET_KEY = process.env.FLOW_SECRET_KEY;
const FLOW_URL = 'https://sandbox.flow.cl/api/payment/create'; // Usa sandbox si es necesario
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Utilidad para firmar los parámetros
function signParams(params, secretKey) {
    // Ordenar alfabéticamente
    const keys = Object.keys(params).sort();
    let stringToSign = '';
    keys.forEach((key) => {
        stringToSign += key + params[key];
    });
    return crypto.createHmac('sha256', secretKey).update(stringToSign).digest('hex');
}
// Endpoint para recibir confirmación de pago de FLOW
app.post('/api/flow-confirm', async (req, res) => {
  try {
    const { commerceOrder, status } = req.body; 
    // 👆 O si consultas con getStatus: const { commerceOrder, status } = response.data;

    console.log("Pedido recibido:", commerceOrder, "Status:", status);

    let nuevoEstado = "Pendiente";

    if (status === 2) nuevoEstado = "Pagado";
    else if (status === 3) nuevoEstado = "Rechazado";
    else if (status === 4) nuevoEstado = "Anulado";

    // Actualizar en Supabase
    const { error } = await supabase
      .from("pedidos")
      .update({ estado: nuevoEstado })
      .eq("id", commerceOrder);

    if (error) throw error;

    res.status(200).json({ message: "OK" });
  } catch (err) {
    console.error("Error Flow Webhook:", err.message);
    res.status(500).json({ error: "Error procesando pago" });
  }
});


app.post('/api/flow-order', async (req, res) => {
  try {
    const { orderId, subject, amount, email } = req.body;
      // Redondear el monto a entero para CLP
      const amountInt = Math.round(amount);
      // Parámetros requeridos por FLOW
      const params = {
        apiKey: API_KEY,
        commerceOrder: orderId,
        subject: subject,
        currency: 'CLP',
        amount: amountInt,
        email: email,
        paymentMethod: 9, // 9 = todos los métodos
        urlConfirmation: process.env.FLOW_CONFIRM_URL, // Debe ser pública
        urlReturn: process.env.FLOW_RETURN_URL, // Debe ser pública
      };
    // Firmar
    params.s = signParams(params, SECRET_KEY);
    // Llamar a FLOW
    const response = await axios.post(FLOW_URL, new URLSearchParams(params), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    res.json(response.data);
  } catch (err) {
    console.error('Error en /api/flow-order:', err, err.response?.data);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

app.get('/flow-redirect', (req, res) => {
  // Puedes pasar parámetros si lo necesitas, por ejemplo ?status=success
  res.redirect('https://tioflashstore.netlify.app/pago-exitoso');
});

app.post('/flow-redirect', (req, res) => {
  // Puedes pasar parámetros si lo necesitas, por ejemplo ?status=success
  res.redirect('https://tioflashstore.netlify.app/pago-exitoso');
});
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log('Backend FLOW escuchando en puerto', PORT);
});






