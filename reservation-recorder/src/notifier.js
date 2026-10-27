// Único lugar que entrega los avisos del hotel mediante EmailJS o logs.
//
// Variables de entorno:
//   NOTIFY_MODE=log|emailjs
//   EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY
//   EMAILJS_PRIVATE_KEY (opcional, recomendado para proteger el envío server-side)
//
// Toda respuesta que no sea un 2xx con JSON se trata como error: el mensaje se reintenta y, tras 3 intentos,
// va a la DLQ. Así un aviso nunca se da por entregado cuando no se creó.
const EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send";
const TIMEOUT_MS = 8000;

async function sendNotice(text, recipient) {
  if (process.env.NOTIFY_MODE === "log") {
    console.log(`[NOTIFY_MODE=log] Aviso del hotel:\n${text}`);
    return { delivered: false };
  }

  if (process.env.NOTIFY_MODE !== "emailjs") {
    throw new Error("NOTIFY_MODE debe ser log o emailjs");
  }

  const serviceId = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_ID;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY;
  if (!serviceId || !templateId || !publicKey || !recipient) {
    throw new Error(
      "EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY y el destinatario son obligatorios",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(EMAILJS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: serviceId,
        template_id: templateId,
        user_id: publicKey,
        ...(process.env.EMAILJS_PRIVATE_KEY
          ? { accessToken: process.env.EMAILJS_PRIVATE_KEY }
          : {}),
        template_params: {
          to_email: recipient,
          email: recipient,
          recipient,
          message: text,
          text,
          subject: "Actualización de reserva - Hotel Boutique 360",
          hotel_name: "Hotel Boutique 360",
        },
      }),
      signal: controller.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`EmailJS rechazó el envío (${response.status}): ${responseBody.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timeout);
  }

  console.log("Aviso enviado por EmailJS");
  return { delivered: true };
}

module.exports = { sendNotice };
