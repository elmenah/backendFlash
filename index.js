// Backend para crear orden de pago con Mercado Pago Chile
const express = require('express');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Configurar Mercado Pago con credenciales de Chile
const client = new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
    options: {
        timeout: 5000
    }
});

// Configurar Supabase
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Endpoint para crear preferencia de pago
app.post('/api/mercadopago-order', async (req, res) => {
    try {
        const { orderId, subject, amount, email } = req.body;

        // Validar parámetros
        if (!orderId || !subject || !amount || !email) {
            return res.status(400).json({ 
                error: 'Faltan parámetros requeridos',
                required: ['orderId', 'subject', 'amount', 'email']
            });
        }

        const preference = new Preference(client);

        const requestBody = {
            items: [
                {
                    id: orderId,
                    title: subject,
                    quantity: 1,
                    unit_price: Number(amount),
                    currency_id: 'CLP'
                }
            ],
            payer: {
                email: email
            },
            back_urls: {
                success: 'https://backendflash.onrender.com/mercadopago-success',
                failure: 'https://backendflash.onrender.com/mercadopago-failure',
                pending: 'https://backendflash.onrender.com/mercadopago-pending'
            },
            auto_return: 'approved',
            external_reference: orderId,
            notification_url: 'https://backendflash.onrender.com/api/mercadopago-webhook',
            statement_descriptor: 'TioFlashStore',
            expires: false,
            payment_methods: {
                excluded_payment_methods: [],
                excluded_payment_types: [],
                installments: 12
            }
        };

        const response = await preference.create({ body: requestBody });
        
        console.log('Preferencia creada:', {
            id: response.id,
            external_reference: orderId
        });
        
        res.json({
            id: response.id,
            init_point: response.init_point,
            sandbox_init_point: response.sandbox_init_point
        });

    } catch (error) {
        console.error('Error creando preferencia MP:', error);
        res.status(500).json({ 
            error: 'Error creando preferencia de pago',
            details: error.message 
        });
    }
});

// Webhook para recibir notificaciones de Mercado Pago
app.post('/api/mercadopago-webhook', async (req, res) => {
    try {
        const { type, data } = req.body;
        
        console.log('Webhook recibido:', { type, data });

        if (type === 'payment') {
            const payment = new Payment(client);
            const paymentInfo = await payment.get({ id: data.id });
            
            console.log('Info del pago:', {
                id: paymentInfo.id,
                status: paymentInfo.status,
                external_reference: paymentInfo.external_reference
            });

            // Actualizar estado en Supabase
            let nuevoEstado = "Pendiente";
            if (paymentInfo.status === 'approved') nuevoEstado = "Pagado";
            else if (paymentInfo.status === 'rejected') nuevoEstado = "Rechazado";
            else if (paymentInfo.status === 'cancelled') nuevoEstado = "Anulado";
            else if (paymentInfo.status === 'pending' || paymentInfo.status === 'in_process') nuevoEstado = "Pendiente";

            if (paymentInfo.external_reference) {
                const { error } = await supabase
                    .from("pedidos")
                    .update({ estado: nuevoEstado })
                    .eq("id", paymentInfo.external_reference);

                if (error) {
                    console.error('Error actualizando pedido en Supabase:', error);
                } else {
                    console.log(`Pedido ${paymentInfo.external_reference} actualizado a ${nuevoEstado}`);
                }
            }
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error procesando webhook:', error);
        res.status(500).send('Error');
    }
});

// Rutas de redirección después del pago
app.get('/mercadopago-success', (req, res) => {
    const { collection_id, collection_status, external_reference } = req.query;
    console.log('Pago exitoso:', { collection_id, collection_status, external_reference });
    res.redirect('https://tioflashstore.netlify.app/pago-exitoso');
});

app.get('/mercadopago-failure', (req, res) => {
    const { collection_id, collection_status, external_reference } = req.query;
    console.log('Pago fallido:', { collection_id, collection_status, external_reference });
    res.redirect('https://tioflashstore.netlify.app/pago-fallido');
});

app.get('/mercadopago-pending', (req, res) => {
    const { collection_id, collection_status, external_reference } = req.query;
    console.log('Pago pendiente:', { collection_id, collection_status, external_reference });
    res.redirect('https://tioflashstore.netlify.app/pago-pendiente');
});

// Endpoint para verificar estado de un pago específico
app.get('/api/payment-status/:paymentId', async (req, res) => {
    try {
        const payment = new Payment(client);
        const paymentData = await payment.get({ id: req.params.paymentId });
        
        res.json({
            status: paymentData.status,
            status_detail: paymentData.status_detail,
            external_reference: paymentData.external_reference,
            transaction_amount: paymentData.transaction_amount
        });
    } catch (error) {
        console.error('Error obteniendo estado:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log('Backend Mercado Pago escuchando en puerto', PORT);
});