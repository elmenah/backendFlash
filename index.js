// Backend mínimo para crear orden de pago FLOW
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Configura tus credenciales FLOW en un archivo .env
const API_KEY = process.env.FLOW_API_KEY;
const SECRET_KEY = process.env.FLOW_SECRET_KEY;
const FLOW_URL = 'https://sandbox.flow.cl/api/payment/create'; // Usa sandbox si es necesario

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
app.post('/api/flow-confirm', (req, res) => {
  // Aquí puedes procesar la notificación, actualizar el pedido, etc.
  // Por ahora solo responde 200 para que FLOW no marque error
  res.status(200).send('OK');
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

app.post('/flow-redirect', (req, res) => {
  // Puedes pasar parámetros si lo necesitas, por ejemplo ?status=success
  res.redirect('https://tioflashstore.netlify.app/pago-exitoso');
});
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log('Backend FLOW escuchando en puerto', PORT);
});

