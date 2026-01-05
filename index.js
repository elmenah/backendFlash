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
                .select(`*, pedido_items ( nombre_producto, precio_unitario, cantidad )`)
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log('Backend Mercado Pago escuchando en puerto', PORT);
});





