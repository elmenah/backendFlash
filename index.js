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

        // ✅ CONVERTIR A ENTERO (requerido para CLP)
        const unitPrice = Math.round(Number(amount));
        
        console.log('Creando preferencia con:', {
            orderId,
            subject,
            unitPrice,
            email
        });

        const preference = new Preference(client);

        const requestBody = {
            items: [
                {
                    id: orderId,
                    title: subject,
                    quantity: 1,
                    unit_price: unitPrice,
                    currency_id: 'CLP'
                }
            ],
            payer: {
                email: email
            },
            back_urls: {
                success: `https://backendflash.onrender.com/mercadopago-success?order=${orderId}&email=${encodeURIComponent(email)}`,
                failure: `https://backendflash.onrender.com/mercadopago-failure?order=${orderId}`,
                pending: `https://backendflash.onrender.com/mercadopago-pending?order=${orderId}`
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
        
        console.log('Preferencia creada exitosamente:', {
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
            details: error.message,
            mercadopagoError: error.cause || error
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

// ✅ Rutas de redirección después del pago - AQUÍ es donde se procesa el éxito
app.get('/mercadopago-success', async (req, res) => {
    const { collection_id, collection_status, external_reference, order, email } = req.query;
    console.log('Pago exitoso:', { collection_id, collection_status, external_reference, order, email });
    try {
        // Obtener datos del pedido desde Supabase
        const pedidoId = external_reference || order;
        let wspParams = '';
        if (pedidoId) {
            const { data: pedidoData, error: pedidoError } = await supabase
                .from('pedidos')
                .select(`*, pedido_items ( nombre_producto, precio_unitario, cantidad, imagen_url )`)
                .eq('id', pedidoId)
                .single();

            if (pedidoError) {
                console.error('Error obteniendo pedido:', pedidoError);
            } else if (pedidoData) {
                const CLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' });
                const total = pedidoData.pedido_items.reduce((sum, item) => sum + (item.precio_unitario * item.cantidad), 0);

                let mensaje = `🎉 ¡PAGO EXITOSO! - Tio Flashstore%0A`;
                mensaje += `========================================%0A`;
                mensaje += `Pedido #${pedidoData.id} - PAGADO ✅%0A`;
                mensaje += `========================================%0A`;

                pedidoData.pedido_items.forEach((item) => {
                    mensaje += `• ${item.nombre_producto} x${item.cantidad} - ${CLP.format(item.precio_unitario)}%0A`;
                    // ✅ INCLUIR LA URL DE LA IMAGEN
                    if (item.imagen_url) {
                        mensaje += `  🖼️ ${item.imagen_url}%0A`;
                    }
                });

                mensaje += `========================================%0A`;
                mensaje += `💰 Total pagado: ${CLP.format(total)}%0A`;
                mensaje += `💳 Método: Mercado Pago%0A`;
                mensaje += `========================================%0A`;
                mensaje += `📧 Email: ${pedidoData.correo}%0A`;
                mensaje += `🎮 Usuario Fortnite: ${pedidoData.username_fortnite}%0A`;
                mensaje += `%0A`;
                mensaje += `🆔 RUT: ${pedidoData.rut}%0A`;

                // Información Xbox: si existe xbox_option incluir detalles, si no incluir texto 'No tengo cuenta de xbox'
                if (pedidoData.xbox_option) {
                    mensaje += `------------------------------------%0A`;
                    mensaje += `🎮 Fortnite Crew - Información Xbox:%0A`;
                    mensaje += `Opción: ${pedidoData.xbox_option}%0A`;
                    if (pedidoData.xbox_option === 'cuenta-existente') {
                        if (pedidoData.xbox_email && pedidoData.xbox_email.length) {
                            mensaje += `Correo Xbox: ${pedidoData.xbox_email}%0A`;
                        } else {
                            mensaje += `Correo Xbox: No tengo cuenta de xbox%0A`;
                        }
                        if (pedidoData.xbox_password && pedidoData.xbox_password.length) {
                            mensaje += `Contraseña Xbox: ${pedidoData.xbox_password}%0A`;
                        }
                    } else {
                        // Opción sin-cuenta u otra
                        mensaje += `Correo Xbox: No tengo cuenta de xbox%0A`;
                    }
                }
                // Información Crunchyroll - NUEVO
                if (pedidoData.crunchyroll_option) {
                    mensaje += `========================================%0A`;
                    mensaje += `🎬 Crunchyroll - Tipo de cuenta:%0A`;
                    mensaje += `Opción: ${pedidoData.crunchyroll_option === 'cuenta-nueva' ? 'Cuenta nueva' : 'Activación en cuenta propia'}%0A`;
                }

                // Información ChatGPT - NUEVO
                if (pedidoData.chatgpt_option) {
                    mensaje += `========================================%0A`;
                    mensaje += `🤖 ChatGPT Plus:%0A`;
                    if (pedidoData.chatgpt_option === '1-mes') {
                        mensaje += `Plan: 1 Mes (Por invitación)%0A`;
                        if (pedidoData.chatgpt_email) {
                            mensaje += `Correo para invitación: ${pedidoData.chatgpt_email}%0A`;
                        }
                    } else {
                        mensaje += `Plan: 12 Meses (Activación en cuenta propia)%0A`;
                    }
                }
                // Información IPTV - NUEVO
                if (pedidoData.iptv_option) {
                    mensaje += `========================================%0A`;
                    mensaje += `📺 IPTV Premium:%0A`;
                    mensaje += `Tipo de servicio: ${pedidoData.iptv_option === 'cuenta-nueva' ? 'Cuenta nueva' : 'Renovación'}%0A`;
                }
                
                // Información V-Bucks - NUEVO
                if (pedidoData.vbucks_delivery_method) {
                    mensaje += `========================================%0A`;
                    mensaje += `💎 V-Bucks - Método de entrega:%0A`;
                    
                    if (pedidoData.vbucks_delivery_method === 'epic-link') {
                        mensaje += `Método: Vincular a perfil Epic%0A`;
                        if (pedidoData.vbucks_epic_email) {
                            mensaje += `Epic Email: ${pedidoData.vbucks_epic_email}%0A`;
                        }
                    } else if (pedidoData.vbucks_delivery_method === 'xbox-account') {
                        mensaje += `Método: Cuenta de Xbox%0A`;
                        if (pedidoData.vbucks_xbox_email) {
                            mensaje += `Xbox Email: ${pedidoData.vbucks_xbox_email}%0A`;
                        }
                    } else if (pedidoData.vbucks_delivery_method === 'preloaded-account') {
                        mensaje += `Método: Cuenta precargada%0A`;
                    }
                }
                
                mensaje += `Esta es la confirmación de mi pedido.`;

                wspParams = `?wsp=${encodeURIComponent(mensaje)}`;
            }
        }

        // Redirigir al frontend con parámetros para WhatsApp
        res.redirect(`https://tioflashstore.netlify.app/pago-exitoso${wspParams}`);
    } catch (error) {
        console.error('Error procesando éxito:', error);
        res.redirect('https://tioflashstore.netlify.app/pago-exitoso');
    }
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

// ==========================================
// PAYPAL - Crear orden de pago
// ==========================================
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL = process.env.PAYPAL_MODE === 'live' 
    ? 'https://api-m.paypal.com' 
    : 'https://api-m.sandbox.paypal.com';

// Obtener access token de PayPal
async function getPayPalAccessToken() {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    const data = await response.json();
    return data.access_token;
}

// Crear orden de PayPal
app.post('/api/paypal-create-order', async (req, res) => {
    try {
        const { orderId, subject, amount, email } = req.body;

        if (!orderId || !subject || !amount || !email) {
            return res.status(400).json({ 
                error: 'Faltan parámetros requeridos',
                required: ['orderId', 'subject', 'amount', 'email']
            });
        }

        const accessToken = await getPayPalAccessToken();

        const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    reference_id: String(orderId),
                    description: subject,
                    amount: {
                        currency_code: 'USD',
                        value: String(Number(amount).toFixed(2))
                    }
                }],
                application_context: {
                    brand_name: 'Tio Flashstore',
                    landing_page: 'NO_PREFERENCE',
                    user_action: 'PAY_NOW',
                    return_url: `https://backendflash.onrender.com/paypal-success?order=${orderId}&email=${encodeURIComponent(email)}`,
                    cancel_url: `https://backendflash.onrender.com/paypal-cancel?order=${orderId}`
                }
            })
        });

        const data = await response.json();
        console.log('Orden PayPal creada:', { id: data.id, status: data.status });

        res.json({ id: data.id, status: data.status });

    } catch (error) {
        console.error('Error creando orden PayPal:', error);
        res.status(500).json({ error: 'Error creando orden de PayPal', details: error.message });
    }
});

// Capturar (confirmar) pago de PayPal
app.post('/api/paypal-capture-order', async (req, res) => {
    try {
        const { paypalOrderId, orderId } = req.body;

        if (!paypalOrderId) {
            return res.status(400).json({ error: 'Falta paypalOrderId' });
        }

        const accessToken = await getPayPalAccessToken();

        const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${paypalOrderId}/capture`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        const captureData = await response.json();
        console.log('Captura PayPal:', { id: captureData.id, status: captureData.status });

        if (captureData.status === 'COMPLETED' && orderId) {
            const { error } = await supabase
                .from('pedidos')
                .update({ estado: 'Pagado' })
                .eq('id', orderId);

            if (error) {
                console.error('Error actualizando pedido en Supabase:', error);
            } else {
                console.log(`Pedido ${orderId} actualizado a Pagado (PayPal)`);
            }

            // Construir mensaje de WhatsApp (igual que MercadoPago)
            const { data: pedidoData, error: pedidoError } = await supabase
                .from('pedidos')
                .select(`*, pedido_items ( nombre_producto, precio_unitario, cantidad, imagen_url )`)
                .eq('id', orderId)
                .single();

            let redirectUrl = 'https://tioflashstore.netlify.app/pago-exitoso';

            if (!pedidoError && pedidoData) {
                const CLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' });
                const total = pedidoData.pedido_items.reduce((sum, item) => sum + (item.precio_unitario * item.cantidad), 0);

                let mensaje = `🎉 ¡PAGO EXITOSO! - Tio Flashstore%0A`;
                mensaje += `========================================%0A`;
                mensaje += `Pedido #${pedidoData.id} - PAGADO ✅%0A`;
                mensaje += `========================================%0A`;

                pedidoData.pedido_items.forEach((item) => {
                    mensaje += `• ${item.nombre_producto} x${item.cantidad} - ${CLP.format(item.precio_unitario)}%0A`;
                    if (item.imagen_url) {
                        mensaje += `  🖼️ ${item.imagen_url}%0A`;
                    }
                });

                mensaje += `========================================%0A`;
                mensaje += `💰 Total pagado: ${CLP.format(total)}%0A`;
                mensaje += `💳 Método: PayPal%0A`;
                mensaje += `========================================%0A`;
                mensaje += `📧 Email: ${pedidoData.correo}%0A`;
                mensaje += `🎮 Usuario Fortnite: ${pedidoData.username_fortnite}%0A`;
                mensaje += `🆔 RUT: ${pedidoData.rut}%0A`;

                if (pedidoData.xbox_option) {
                    mensaje += `------------------------------------%0A`;
                    mensaje += `🎮 Fortnite Crew - Información Xbox:%0A`;
                    mensaje += `Opción: ${pedidoData.xbox_option}%0A`;
                    if (pedidoData.xbox_option === 'cuenta-existente') {
                        mensaje += pedidoData.xbox_email ? `Correo Xbox: ${pedidoData.xbox_email}%0A` : `Correo Xbox: No tengo cuenta de xbox%0A`;
                        if (pedidoData.xbox_password) mensaje += `Contraseña Xbox: ${pedidoData.xbox_password}%0A`;
                    } else {
                        mensaje += `Correo Xbox: No tengo cuenta de xbox%0A`;
                    }
                }

                if (pedidoData.crunchyroll_option) {
                    mensaje += `========================================%0A`;
                    mensaje += `🎬 Crunchyroll: ${pedidoData.crunchyroll_option === 'cuenta-nueva' ? 'Cuenta nueva' : 'Activación en cuenta propia'}%0A`;
                }

                if (pedidoData.chatgpt_option) {
                    mensaje += `========================================%0A`;
                    mensaje += `🤖 ChatGPT Plus: ${pedidoData.chatgpt_option === '1-mes' ? '1 Mes (Invitación)' : '12 Meses'}%0A`;
                    if (pedidoData.chatgpt_email) mensaje += `Correo: ${pedidoData.chatgpt_email}%0A`;
                }

                if (pedidoData.vbucks_delivery_method) {
                    mensaje += `========================================%0A`;
                    mensaje += `💎 V-Bucks: ${pedidoData.vbucks_delivery_method}%0A`;
                }

                mensaje += `Esta es la confirmación de mi pedido.`;
                redirectUrl = `https://tioflashstore.netlify.app/pago-exitoso?wsp=${encodeURIComponent(mensaje)}`;
            }

            res.json({ status: captureData.status, id: captureData.id, redirectUrl });
        } else {
            res.json({ status: captureData.status, id: captureData.id, details: captureData.details });
        }

    } catch (error) {
        console.error('Error capturando pago PayPal:', error);
        res.status(500).json({ error: 'Error capturando pago de PayPal', details: error.message });
    }
});

// Rutas de redirección PayPal
app.get('/paypal-success', async (req, res) => {
    const { order } = req.query;
    console.log('PayPal success redirect, orderId:', order);
    res.redirect('https://tioflashstore.netlify.app/pago-exitoso');
});

app.get('/paypal-cancel', (req, res) => {
    const { order } = req.query;
    console.log('PayPal cancelado, orderId:', order);
    res.redirect('https://tioflashstore.netlify.app/pago-fallido');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log('Backend Mercado Pago escuchando en puerto', PORT);
});

