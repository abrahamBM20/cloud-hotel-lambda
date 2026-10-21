// Controller: lee los mensajes de SQS (la cola de cambios de estado) y delega en el service.
// record.body es la envoltura SNS (RawMessageDelivery=false): {"Type":"Notification","Message":"{type,body}",...}
// o, por compatibilidad, el mensaje {type, body} directo.
const service = require("./reservation.service");

function parseRecord(record) {
  const envelope = JSON.parse(record.body);
  const msgStr = envelope.Message ?? record.body;
  const payload = typeof msgStr === "string" ? JSON.parse(msgStr) : msgStr;
  return { type: payload.type, body: payload.body };
}

exports.handler = async (event) => {
  const records = event.Records ?? [];
  const updated = [];
  for (const record of records) {
    const { type, body } = parseRecord(record);
    if (type !== service.MESSAGE_TYPE) {
      // El filtro de la suscripción solo deja pasar "reservation.status-changed".
      throw new Error(`Tipo de mensaje no soportado: ${type}`);
    }
    updated.push(await service.changeStatus(body));
  }
  return { statusCode: 200, body: JSON.stringify(updated) };
};
