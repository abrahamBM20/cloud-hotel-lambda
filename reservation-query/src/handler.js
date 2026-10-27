// Controller: atiende la invocación del BFF y devuelve el JSON de las reservas.
//
// La Lambda se publica con una Function URL. El BFF le manda el evento en formato AWS_PROXY:
//   {"httpMethod":"GET","path":"/reservations","queryStringParameters":{...}}
//
// Hay que contempl las dos formas en que llega ese evento:
//   1. Invocación directa (consola de Lambda, evento de prueba): el evento ES ese objeto.
//   2. Invocación por la Function URL: Lambda envuelve lo que se posteó, así que el evento
//      llega con el sobre estándar (version 2.0) y nuestro objeto viaja dentro de event.body.
const repo = require("./reservation.repository");

function parseEvent(event) {
  let payload = event ?? {};

  // Si el evento trae 'body' como texto, es el sobre de la Function URL.
  if (typeof event?.body === "string" && event.body.trim() !== "") {
    try {
      payload = JSON.parse(event.body);
    } catch (error) {
      console.error("No se pudo parsear el body de la invocación:", error);
      payload = event;
    }
  }

  const query = {
    ...(event?.queryStringParameters ?? {}),
    ...(payload?.queryStringParameters ?? {}),
  };

  const method =
    payload?.httpMethod ?? event?.requestContext?.http?.method ?? "GET";
  const path = payload?.path ?? event?.rawPath ?? "/reservations";

  return { method, path, query };
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event) => {
  try {
    const expectedToken = process.env.RESERVATIONS_QUERY_TOKEN;
    const suppliedToken = event?.headers?.["x-internal-query-token"]
      ?? event?.headers?.["X-Internal-Query-Token"];
    if (!expectedToken || suppliedToken !== expectedToken) {
      return jsonResponse(403, { error: "Invocación no autorizada" });
    }

    const { method, path, query } = parseEvent(event);

    if (method !== "GET" && method !== "POST") {
      return jsonResponse(405, { error: `Método no soportado: ${method}` });
    }
    if (path && !path.startsWith("/reservations")) {
      return jsonResponse(404, { error: `Ruta no encontrada: ${path}` });
    }

    const reservations = await repo.listReservations(query);
    return jsonResponse(200, reservations);
  } catch (error) {
    console.error("Error al leer las reservas:", error);
    return jsonResponse(500, { error: error.message });
  }
};
