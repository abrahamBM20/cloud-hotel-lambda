const repo = require("./reservation.repository");
const notifier = require("./notifier");

const MESSAGE_TYPE = "reservation.requested";

function validateRequest(body) {
  const { reservationId, guestName, roomNumber } = body ?? {};
  if (!reservationId || !guestName || !roomNumber) {
    throw new Error(
      "Solicitud inválida. Se espera {reservationId, guestName, guestEmail?, guestId?, roomNumber, roomType?, checkIn?, checkOut?, guests?, totalAmount?, notes?, requestedAt?}"
    );
  }
  return body;
}

// Lógica de negocio: validar → insertar la reserva → ocupar la habitación → avisar.
async function recordReservation(input) {
  const request = validateRequest(input);
  const client = await repo.getPool().connect();

  let row;
  let occupied = false;
  try {
    await repo.ensureSchema(client);
    await client.query("BEGIN");

    row = await repo.insertReservation(client, request);
    if (!row) {
      // La reserva ya existía (reintento de SQS): no se duplica ni se vuelve a ocupar.
      const existing = await repo.findReservation(client, request.reservationId);
      await client.query("COMMIT");
      return { reservationId: request.reservationId, created: false, status: existing?.status ?? "PENDIENTE" };
    }

    occupied = await repo.occupyRoom(client, request.roomNumber);
    if (!occupied) {
      // Alguien más se llevó la habitación entre la validación del BFF y este insert.
      row = await repo.cancelReservation(
        client,
        request.reservationId,
        "La habitación no estaba disponible al confirmar la reserva"
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Error al registrar la reserva:", error);
    throw error;
  } finally {
    client.release();
  }

  // El aviso es best-effort: si la API de avisos falla, la reserva ya quedó guardada y
  // no conviene reintentar el mensaje (duplicaría la fila). Se deja registrado el error.
  try {
    await notifier.sendNotice(buildNotice(row, occupied, request));
  } catch (noticeError) {
    console.error("No se pudo publicar el aviso de la reserva:", noticeError);
  }

  return {
    reservationId: request.reservationId,
    created: true,
    roomNumber: request.roomNumber,
    status: row?.status ?? "PENDIENTE",
    roomOccupied: occupied,
  };
}

function buildNotice(row, occupied, request) {
  const guest = row?.guest_name ?? request.guestName;
  const room = row?.room_number ?? request.roomNumber;
  if (!occupied) {
    return `Reserva ${row?.id ?? request.reservationId} cancelada: la habitación ${room} ya no estaba disponible.`;
  }
  return `Nueva reserva ${row?.id ?? request.reservationId}: ${guest} en la habitación ${room} para el ${row?.check_in ?? request.checkIn}.`;
}

module.exports = { recordReservation, buildNotice, MESSAGE_TYPE };
