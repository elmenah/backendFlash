// Backend para crear orden de pago con Mercado Pago Chile + Zenobank Cripto + PayPal
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
    options: { timeout: 5000 }
});

// Configurar Supabase
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ==========================================
// BOT DE REGALOS FORTNITE
// ==========================================
const BOT_URL = process.env.BOT_URL || 'http://localhost:8000';
const BOT_SECRET = process.env.BOT_SECRET || '';

async function triggerBotGifts(orderId) {
    try {
        const { data: pedido, error: pedidoError } = await supabase
            .from('pedidos')
            .select('*, pedido_items(*)')
            .eq('id', orderId)
            .single();

        if (pedidoError || !pedido) {
            console.error('[Bot] Error obteniendo pedido:', pedidoError);
            return;
        }

        const epicName = pedido.username_fortnite;
        if (!epicName || epicName === 'N/A') {
            console.log(`[Bot] Pedido ${orderId} sin username de Fortnite, omitiendo regalo`);
            return;
        }

        const fortniteItems = (pedido.pedido_items || []).filter(item => item.offer_id);
        if (fortniteItems.length === 0) {
            console.log(`[Bot] Pedido ${orderId} sin items de Fortnite con offer_id`);
            return;
        }

        console.log(`[Bot] Enviando ${fortniteItems.length} regalo(s) a ${epicName} (pedido ${orderId})`);

        for (const item of fortniteItems) {
            try {
                const response = await fetch(`${BOT_URL}/regalar`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Bot-Secret': BOT_SECRET,
                    },
                    body: JSON.stringify({
                        epic_name: epicName,
                        offer_id: item.offer_id,
                        item_id: String(item.id),
                        price_vbucks: item.pavos || 0,
                    }),
                });

                const result = await response.json();

                if (response.ok && result.success) {
                    console.log(`[Bot] Regalo enviado a ${epicName}: ${item.nombre_producto}`);
                    await supabase
                        .from('pedido_items')
                        .update({ entregado: true })
                        .eq('id', item.id);
                } else {
                    console.error(`[Bot] Error enviando regalo ${item.nombre_producto}: ${result.error}`);
                }
            } catch (e) {
                console.error(`[Bot] Error llamando al bot para item ${item.id}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[Bot] Error en triggerBotGifts:', e.message);
    }
}

// ==========================================
// HELPERS
// ==========================================
function formatStoreExitDate(dateValue) {
    if (!dateValue) return null;
    const parsedDate = new Date(dateValue);
    if (Number.isNaN(parsedDate.getTime())) return String(dateValue);
    return parsedDate.toLocaleString('es-CL', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
}

function getStoreExitDate(item) {
    if (!item || typeof item !== 'object') return null;
    return (
        item.fecha_salida_tienda || item.fecha_salida || item.fecha_fin_tienda ||
        item.fecha_fin || item.fin || item.out_date || item.outDate ||
        item.sale_end_date || item.store_exit_date || null
    );
}

// ==========================================
// TASA DE CAMBIO DINÁMICA CLP → USD
// ==========================================
let cachedRate = { clpPerUsd: 950, timestamp: 0 };
const RATE_CACHE_DURATION = 30 * 60 * 1000;

async function getExchangeRate() {
    const now = Date.now();
    if (now - cachedRate.timestamp < RATE_CACHE_DURATION && cachedRate.clpPerUsd) {
        return cachedRate.clpPerUsd;
    }
    try {
        const res = await fetch('https://open.er-api.com/v6/latest/USD');
        const data = await res.json();
        if (data.result === 'success' && data.rates?.CLP) {
            cachedRate = { clpPerUsd: data.rates.CLP, timestamp: now };
            console.log('Tasa actualizada: 1 USD =', data.rates.CLP, 'CLP');
            return data.rates.CLP;
        }
    } catch (err) {
        console.error('Error obteniendo tasa de cambio:', err.message);
    }
    return cachedRate.clpPerUsd || 950;
}

app.get('/api/exchange-rate', async (req, res) => {
    try {
        const rate = await getExchangeRate();
        res.json({ clpPerUsd: rate, source: 'open.er-api.com' });
    } catch (error) {
        res.json({ clpPerUsd: 950, source: 'fallback' });
    }
});

// ==========================================
// MERCADO PAGO
// ==========================================
app.post('/api/mercadopago-order', async (req, res) => {
    try {
        const { orderId, subject, amount, email } = req.body;
        if (!orderId || !subject || !amount || !email) {
            return res.status(400).json({
                error: 'Faltan parámetros requeridos',
                required: ['orderId', 'subject', 'amount', 'email']
            });
        }

        const unitPrice = Math.round(Number(amount));
        console.log('Creando preferencia con:', { orderId, subject, unitPrice, email });

        const preference = new Preference(client);
        const requestBody = {
            items: [{ id: orderId, title: subject, quantity: 1, unit_price: unitPrice, currency_id: 'CLP' }],
            payer: { email },
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
            payment_methods: { excluded_payment_methods: [], excluded_payment_types: [], installments: 12 }
        };

        const response = await preference.create({ body: requestBody });
        console.log('Preferencia creada exitosamente:', { id: response.id, external_reference: orderId });
        res.json({ id: response.id, init_point: response.init_point, sandbox_init_point: response.sandbox_init_point });
    } catch (error) {
        console.error('Error creando preferencia MP:', error);
        res.status(500).json({ error: 'Error creando preferencia de pago', details: error.message, mercadopagoError: error.cause || error });
    }
});

app.post('/api/mercadopago-webhook', async (req, res) => {
    try {
        const { type, data } = req.body;
        console.log('Webhook recibido:', { type, data });

        if (type === 'payment') {
            const payment = new Payment(client);
            const paymentInfo = await payment.get({ id: data.id });
            console.log('Info del pago:', { id: paymentInfo.id, status: paymentInfo.status, external_reference: paymentInfo.external_reference });

            let nuevoEstado = 'Pendiente';
            if (paymentInfo.status === 'approved') nuevoEstado = 'Pagado';
            else if (paymentInfo.status === 'rejected') nuevoEstado = 'Rechazado';
            else if (paymentInfo.status === 'cancelled') nuevoEstado = 'Anulado';
            else if (paymentInfo.status === 'pending' || paymentInfo.status === 'in_process') nuevoEstado = 'Pendiente';

            if (paymentInfo.external_reference) {
                const { error } = await supabase
                    .from('pedidos')
                    .update({ estado: nuevoEstado })
                    .eq('id', paymentInfo.external_reference);

                if (error) {
                    console.error('Error actualizando pedido en Supabase:', error);
                } else {
                    console.log(`Pedido ${paymentInfo.external_reference} actualizado a ${nuevoEstado}`);
                    if (nuevoEstado === 'Pagado') {
                        triggerBotGifts(paymentInfo.external_reference);
                    }
                }
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Error procesando webhook:', error);
        res.status(500).send('Error');
    }
});

app.get('/mercadopago-success', async (req, res) => {
    const { external_reference, order, email } = req.query;
    const pedidoId = external_reference || order;
    console.log('Pago exitoso MP:', { pedidoId, email });
    try {
        let wspParams = '';
        if (pedidoId) {
            const { data: pedidoData, error: pedidoError } = await supabase
                .from('pedidos')
                .select('*, pedido_items(*)')
                .eq('id', pedidoId)
                .single();

            if (!pedidoError && pedidoData) {
                const CLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' });
                const total = pedidoData.pedido_items.reduce((sum, item) => sum + (item.precio_unitario * item.cantidad), 0);

                let mensaje = `🎉 ¡PAGO EXITOSO! - Tio Flashstore%0A`;
                mensaje += `========================================%0A`;
                mensaje += `Pedido #${pedidoData.id} - PAGADO ✅%0A`;
                mensaje += `========================================%0A`;
                pedidoData.pedido_items.forEach((item) => {
                    mensaje += `• ${item.nombre_producto} x${item.cantidad} - ${CLP.format(item.precio_unitario)}%0A`;
                    if (item.imagen_url) mensaje += `  🖼️ ${item.imagen_url}%0A`;
                    const storeExitDate = getStoreExitDate(item);
                    if (storeExitDate) mensaje += `  📅 Se va de la tienda: ${formatStoreExitDate(storeExitDate)}%0A`;
                });
                mensaje += `========================================%0A`;
                mensaje += `💰 Total pagado: ${CLP.format(total)}%0A`;
                mensaje += `💳 Método: Mercado Pago%0A`;
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
                if (pedidoData.iptv_option) {
                    mensaje += `========================================%0A`;
                    mensaje += `📺 IPTV Premium: ${pedidoData.iptv_option === 'cuenta-nueva' ? 'Cuenta nueva' : 'Renovación'}%0A`;
                }
                if (pedidoData.vbucks_delivery_method) {
                    mensaje += `========================================%0A`;
                    mensaje += `💎 V-Bucks: ${pedidoData.vbucks_delivery_method}%0A`;
                }
                mensaje += `Esta es la confirmación de mi pedido.`;
                wspParams = `?wsp=${encodeURIComponent(mensaje)}`;
            }
        }
        res.redirect(`https://tioflashstore.netlify.app/pago-exitoso${wspParams}`);
    } catch (error) {
        console.error('Error procesando éxito MP:', error);
        res.redirect('https://tioflashstore.netlify.app/pago-exitoso');
    }
});

app.get('/mercadopago-failure', (req, res) => {
    res.redirect('https://tioflashstore.netlify.app/pago-fallido');
});

app.get('/mercadopago-pending', (req, res) => {
    res.redirect('https://tioflashstore.netlify.app/pago-pendiente');
});

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
// ZENOBANK
// ==========================================
const ZENOBANK_API_KEY = process.env.ZENOBANK_API_KEY;

app.post('/api/zenobank-checkout', async (req, res) => {
    try {
        const { orderId, subject, amount, email } = req.body;
        if (!orderId || !subject || !amount || !email) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos', required: ['orderId', 'subject', 'amount', 'email'] });
        }

        const rate = await getExchangeRate();
        const amountUSD = (Number(amount) / rate).toFixed(2);
        console.log('Creando checkout Zenobank:', { orderId, amountUSD, rate, email });

        const response = await fetch('https://api.zenobank.io/api/v1/checkouts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': ZENOBANK_API_KEY },
            body: JSON.stringify({
                orderId: String(orderId),
                priceAmount: String(amountUSD),
                priceCurrency: 'USD',
                webhookUrl: 'https://backendflash.onrender.com/api/zenobank-webhook',
                successRedirectUrl: `https://backendflash.onrender.com/zenobank-success?order=${orderId}&email=${encodeURIComponent(email)}`
            })
        });

        const data = await response.json();
        console.log('Checkout Zenobank creado:', { id: data.id, status: data.status, checkoutUrl: data.checkoutUrl });

        if (data.checkoutUrl) {
            res.json({ id: data.id, checkoutUrl: data.checkoutUrl, status: data.status });
        } else {
            throw new Error(data.message || 'No se pudo crear el checkout');
        }
    } catch (error) {
        console.error('Error creando checkout Zenobank:', error);
        res.status(500).json({ error: 'Error creando checkout de Zenobank', details: error.message });
    }
});

app.post('/api/zenobank-webhook', async (req, res) => {
    try {
        const payload = req.body;
        console.log('Webhook Zenobank recibido:', payload);

        const orderId = payload.orderId;
        const status = payload.status;

        if (orderId && status) {
            let nuevoEstado = 'Pendiente';
            if (status === 'COMPLETED' || status === 'PAID') nuevoEstado = 'Pagado';
            else if (status === 'EXPIRED' || status === 'CANCELLED') nuevoEstado = 'Anulado';

            const { error } = await supabase
                .from('pedidos')
                .update({ estado: nuevoEstado })
                .eq('id', orderId);

            if (error) {
                console.error('Error actualizando pedido (Zenobank):', error);
            } else {
                console.log(`Pedido ${orderId} actualizado a ${nuevoEstado} (Zenobank)`);
                if (nuevoEstado === 'Pagado') {
                    triggerBotGifts(orderId);
                }
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Error procesando webhook Zenobank:', error);
        res.status(500).send('Error');
    }
});

app.get('/zenobank-success', async (req, res) => {
    const { order, email } = req.query;
    console.log('Zenobank pago exitoso:', { order, email });
    try {
        const pedidoId = order;
        let wspParams = '';

        if (pedidoId) {
            await supabase.from('pedidos').update({ estado: 'Pagado' }).eq('id', pedidoId);
            triggerBotGifts(pedidoId);

            const { data: pedidoData, error: pedidoError } = await supabase
                .from('pedidos')
                .select('*, pedido_items(*)')
                .eq('id', pedidoId)
                .single();

            if (!pedidoError && pedidoData) {
                const CLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' });
                const total = pedidoData.pedido_items.reduce((sum, item) => sum + (item.precio_unitario * item.cantidad), 0);

                let mensaje = `🎉 ¡PAGO EXITOSO! - Tio Flashstore%0A`;
                mensaje += `========================================%0A`;
                mensaje += `Pedido #${pedidoData.id} - PAGADO ✅%0A`;
                mensaje += `========================================%0A`;
                pedidoData.pedido_items.forEach((item) => {
                    mensaje += `• ${item.nombre_producto} x${item.cantidad} - ${CLP.format(item.precio_unitario)}%0A`;
                    if (item.imagen_url) mensaje += `  🖼️ ${item.imagen_url}%0A`;
                    const storeExitDate = getStoreExitDate(item);
                    if (storeExitDate) mensaje += `  📅 Se va de la tienda: ${formatStoreExitDate(storeExitDate)}%0A`;
                });
                mensaje += `========================================%0A`;
                mensaje += `💰 Total pagado: ${CLP.format(total)}%0A`;
                mensaje += `💳 Método: Criptomonedas (Zenobank)%0A`;
                mensaje += `========================================%0A`;
                mensaje += `📧 Email: ${pedidoData.correo}%0A`;
                mensaje += `🎮 Usuario Fortnite: ${pedidoData.username_fortnite}%0A`;
                mensaje += `🆔 RUT: ${pedidoData.rut}%0A`;
                if (pedidoData.xbox_option) {
                    mensaje += `------------------------------------%0A`;
                    mensaje += `🎮 Fortnite Crew: ${pedidoData.xbox_option}%0A`;
                    if (pedidoData.xbox_option === 'cuenta-existente') {
                        mensaje += pedidoData.xbox_email ? `Correo Xbox: ${pedidoData.xbox_email}%0A` : `Correo Xbox: No tengo cuenta de xbox%0A`;
                        if (pedidoData.xbox_password) mensaje += `Contraseña Xbox: ${pedidoData.xbox_password}%0A`;
                    }
                }
                if (pedidoData.crunchyroll_option) mensaje += `========================================%0A🎬 Crunchyroll: ${pedidoData.crunchyroll_option === 'cuenta-nueva' ? 'Cuenta nueva' : 'Activación en cuenta propia'}%0A`;
                if (pedidoData.chatgpt_option) {
                    mensaje += `========================================%0A🤖 ChatGPT Plus: ${pedidoData.chatgpt_option === '1-mes' ? '1 Mes (Invitación)' : '12 Meses'}%0A`;
                    if (pedidoData.chatgpt_email) mensaje += `Correo: ${pedidoData.chatgpt_email}%0A`;
                }
                if (pedidoData.iptv_option) mensaje += `========================================%0A📺 IPTV Premium: ${pedidoData.iptv_option === 'cuenta-nueva' ? 'Cuenta nueva' : 'Renovación'}%0A`;
                if (pedidoData.vbucks_delivery_method) mensaje += `========================================%0A💎 V-Bucks: ${pedidoData.vbucks_delivery_method}%0A`;
                mensaje += `Esta es la confirmación de mi pedido.`;
                wspParams = `?wsp=${encodeURIComponent(mensaje)}`;
            }
        }
        res.redirect(`https://tioflashstore.netlify.app/pago-exitoso${wspParams}`);
    } catch (error) {
        console.error('Error procesando éxito Zenobank:', error);
        res.redirect('https://tioflashstore.netlify.app/pago-exitoso');
    }
});

// ==========================================
// PAYPAL
// ==========================================
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE = process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

async function getPayPalAccessToken() {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
    });
    const data = await response.json();
    return data.access_token;
}

app.get('/api/paypal/client-id', (req, res) => {
    res.json({ clientId: PAYPAL_CLIENT_ID });
});

app.post('/api/paypal/create-order', async (req, res) => {
    try {
        const { orderId, amount, email } = req.body;
        if (!orderId || !amount || !email) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos', required: ['orderId', 'amount', 'email'] });
        }

        const rate = await getExchangeRate();
        const baseUSD = Number((Number(amount) / rate).toFixed(2));
        const amountUSD = ((baseUSD + 0.30) / (1 - 0.054)).toFixed(2);
        console.log('Creando orden PayPal:', { orderId, baseUSD, amountUSD, rate, email });

        const accessToken = await getPayPalAccessToken();
        const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{ reference_id: String(orderId), amount: { currency_code: 'USD', value: amountUSD } }],
                payment_source: {
                    paypal: {
                        experience_context: {
                            brand_name: 'Tio Flash Store',
                            landing_page: 'NO_PREFERENCE',
                            user_action: 'PAY_NOW',
                            return_url: `https://backendflash.onrender.com/paypal-success?order=${orderId}&email=${encodeURIComponent(email)}`,
                            cancel_url: 'https://tioflashstore.netlify.app/pago-fallido'
                        }
                    }
                }
            })
        });

        const data = await response.json();
        console.log('Orden PayPal creada:', { id: data.id, status: data.status });

        if (data.id) {
            const approveLink = data.links?.find(link => link.rel === 'payer-action' || link.rel === 'approve');
            res.json({ id: data.id, status: data.status, approveUrl: approveLink?.href || null });
        } else {
            throw new Error(data.message || JSON.stringify(data.details) || 'No se pudo crear la orden');
        }
    } catch (error) {
        console.error('Error creando orden PayPal:', error);
        res.status(500).json({ error: 'Error creando orden de PayPal', details: error.message });
    }
});

app.post('/api/paypal/capture-order/:orderID', async (req, res) => {
    try {
        const { orderID } = req.params;
        console.log('Capturando pago PayPal:', orderID);

        const accessToken = await getPayPalAccessToken();
        const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderID}/capture`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }
        });

        const data = await response.json();
        console.log('Captura PayPal:', { id: data.id, status: data.status });

        if (data.status === 'COMPLETED') {
            const referenceId = data.purchase_units?.[0]?.reference_id;
            if (referenceId) {
                const { error } = await supabase
                    .from('pedidos')
                    .update({ estado: 'Pagado' })
                    .eq('id', referenceId);

                if (error) {
                    console.error('Error actualizando pedido PayPal en Supabase:', error);
                } else {
                    console.log(`Pedido ${referenceId} actualizado a Pagado (PayPal)`);
                    triggerBotGifts(referenceId);
                }
            }
        }

        res.json(data);
    } catch (error) {
        console.error('Error capturando pago PayPal:', error);
        res.status(500).json({ error: 'Error capturando pago de PayPal', details: error.message });
    }
});

app.get('/paypal-success', async (req, res) => {
    const { order, email, token } = req.query;
    console.log('PayPal pago exitoso:', { order, email, token });
    try {
        if (token) {
            const accessToken = await getPayPalAccessToken();
            await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${token}/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }
            });
        }

        const pedidoId = order;
        let wspParams = '';

        if (pedidoId) {
            await supabase.from('pedidos').update({ estado: 'Pagado' }).eq('id', pedidoId);
            triggerBotGifts(pedidoId);

            const { data: pedidoData, error: pedidoError } = await supabase
                .from('pedidos')
                .select('*, pedido_items(*)')
                .eq('id', pedidoId)
                .single();

            if (!pedidoError && pedidoData) {
                const CLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' });
                const total = pedidoData.pedido_items.reduce((sum, item) => sum + (item.precio_unitario * item.cantidad), 0);

                let mensaje = `🎉 ¡PAGO EXITOSO! - Tio Flashstore%0A`;
                mensaje += `========================================%0A`;
                mensaje += `Pedido #${pedidoData.id} - PAGADO ✅%0A`;
                mensaje += `========================================%0A`;
                pedidoData.pedido_items.forEach((item) => {
                    mensaje += `• ${item.nombre_producto} x${item.cantidad} - ${CLP.format(item.precio_unitario)}%0A`;
                    if (item.imagen_url) mensaje += `  🖼️ ${item.imagen_url}%0A`;
                    const storeExitDate = getStoreExitDate(item);
                    if (storeExitDate) mensaje += `  📅 Se va de la tienda: ${formatStoreExitDate(storeExitDate)}%0A`;
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
                    mensaje += `🎮 Fortnite Crew: ${pedidoData.xbox_option}%0A`;
                    if (pedidoData.xbox_option === 'cuenta-existente') {
                        mensaje += pedidoData.xbox_email ? `Correo Xbox: ${pedidoData.xbox_email}%0A` : `Correo Xbox: No tengo cuenta de xbox%0A`;
                        if (pedidoData.xbox_password) mensaje += `Contraseña Xbox: ${pedidoData.xbox_password}%0A`;
                    }
                }
                if (pedidoData.crunchyroll_option) mensaje += `========================================%0A🎬 Crunchyroll: ${pedidoData.crunchyroll_option === 'cuenta-nueva' ? 'Cuenta nueva' : 'Activación en cuenta propia'}%0A`;
                if (pedidoData.chatgpt_option) {
                    mensaje += `========================================%0A🤖 ChatGPT Plus: ${pedidoData.chatgpt_option === '1-mes' ? '1 Mes (Invitación)' : '12 Meses'}%0A`;
                    if (pedidoData.chatgpt_email) mensaje += `Correo: ${pedidoData.chatgpt_email}%0A`;
                }
                if (pedidoData.iptv_option) mensaje += `========================================%0A📺 IPTV Premium: ${pedidoData.iptv_option === 'cuenta-nueva' ? 'Cuenta nueva' : 'Renovación'}%0A`;
                if (pedidoData.vbucks_delivery_method) mensaje += `========================================%0A💎 V-Bucks: ${pedidoData.vbucks_delivery_method}%0A`;
                mensaje += `Esta es la confirmación de mi pedido.`;
                wspParams = `?wsp=${encodeURIComponent(mensaje)}`;
            }
        }
        res.redirect(`https://tioflashstore.netlify.app/pago-exitoso${wspParams}`);
    } catch (error) {
        console.error('Error procesando éxito PayPal:', error);
        res.redirect('https://tioflashstore.netlify.app/pago-exitoso');
    }
});

// ==========================================
// BOT PROXY ENDPOINTS (para el panel admin)
// ==========================================
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'menanicolas161@gmail.com';

async function verifyAdmin(req, res) {
    const token = req.headers['x-admin-token'];
    if (!token) { res.status(401).json({ error: 'No autorizado' }); return false; }
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user || user.email !== ADMIN_EMAIL) {
        res.status(401).json({ error: 'No autorizado' }); return false;
    }
    return true;
}

app.get('/api/bot/stats', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/stats`);
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

app.get('/api/bot/health', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/health`);
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

app.get('/api/bot/tienda', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/tienda`);
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

app.post('/api/bot/reload', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/bots/reload`, { method: 'POST' });
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

app.post('/api/bot/refresh-balances', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/refresh-balances`, {
            method: 'POST',
            headers: { 'X-Bot-Secret': BOT_SECRET }
        });
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

app.post('/api/bot/reactivar/:accountId', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/bots/${req.params.accountId}/reactivar`, { method: 'POST' });
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

app.post('/api/bot/set-pavos/:accountId', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/bots/${req.params.accountId}/set-pavos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': BOT_SECRET },
            body: JSON.stringify(req.body)
        });
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

app.post('/api/bot/set-slots/:accountId', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/bots/${req.params.accountId}/set-slots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': BOT_SECRET },
            body: JSON.stringify(req.body)
        });
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

app.get('/api/bot/es-amigo/:epicName', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/es-amigo/${encodeURIComponent(req.params.epicName)}`);
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

app.post('/api/bot/agregar', async (req, res) => {
    if (!await verifyAdmin(req, res)) return;
    try {
        const r = await fetch(`${BOT_URL}/agregar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        res.json(await r.json());
    } catch (e) { res.status(503).json({ error: 'Bot no disponible' }); }
});

// ==========================================
// SCRAPING IMAGEN CREW DE FORTNITE
// ==========================================
let cachedCrewImage = { url: null, timestamp: 0 };
const CREW_CACHE_DURATION = 60 * 60 * 1000;

app.get('/api/crew-image', async (req, res) => {
    try {
        const now = Date.now();
        if (cachedCrewImage.url && now - cachedCrewImage.timestamp < CREW_CACHE_DURATION) {
            return res.json({ image: cachedCrewImage.url, source: 'cache' });
        }

        const axios = require('axios');
        const response = await axios.get('https://www.fortnite.com/fortnite-crew-subscription?lang=es-ES', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
            timeout: 10000
        });

        const html = response.data;
        const match = html.match(/src="(https:\/\/cms-assets\.unrealengine\.com\/[^"]+\/output=format:webp\/[^"]+)"/);
        if (match && match[1]) {
            cachedCrewImage = { url: match[1], timestamp: now };
            return res.json({ image: match[1], source: 'live' });
        }

        const fallbackMatch = html.match(/src="(https:\/\/cms-assets\.unrealengine\.com\/[^"]+)"/);
        if (fallbackMatch && fallbackMatch[1]) {
            cachedCrewImage = { url: fallbackMatch[1], timestamp: now };
            return res.json({ image: fallbackMatch[1], source: 'fallback' });
        }

        res.status(404).json({ error: 'No se encontró imagen del Crew' });
    } catch (error) {
        console.error('Error scraping crew image:', error.message);
        if (cachedCrewImage.url) return res.json({ image: cachedCrewImage.url, source: 'stale-cache' });
        res.status(500).json({ error: 'Error obteniendo imagen del Crew' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Backend escuchando en puerto ${PORT}`);
    console.log(`Bot URL configurada: ${BOT_URL}`);
});
