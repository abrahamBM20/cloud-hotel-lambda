const repo = require("./reservation.repository");
const notifier = require("./notifier");

const MESSAGE_TYPE = "reservation.status-changed";

/** Estados que devuelven la habitación al catálogo. */
const RELEASES_ROOM = new Set(["CHECKED_OUT", "CANCELADA"]);

function validateRequest(body) {
  const { reservationId, newStatus } = body ?? {};
  if (!reservationId || !newStatus) {
    throw new Error(
      "Cambio de estado inválido. Se espera {reservationId, newStatus, notes?, changedBy?, changedAt?}"
    );
  }
  return body;
}

// Lógica de negocio: validar → actualizar el estado → liberar la habitación si corresponde → avisar.
async function changeStatus(input) {
  const request = validateRequest(input);
  const newStatus = String(request.newStatus).trim().toUpperCase();
  const client = await repo.getPool().connect();

  let row;
  let roomFreed = false;
  try {
    await client.query("BEGIN");

    const before = await repo.findReservation(client, request.reservationId);
    if (!before) {
      await client.query("ROLLBACK");
      throw new Error(`La reserva ${request.reservationId} no existe`);
    }

    row = await repo.updateStatus(client, request.reservationId, newStatus, request.notes);

    if (RELEASES_ROOM.has(newStatus)) {
      roomFreed = await repo.freeRoom(client, before.room_number);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Error al cambiar el estado de la reserva:", error);
    throw error;
  } finally {
    client.release();
  }

  // El aviso es best-effort: la reserva ya quedó actualizada y no conviene reintentar el mensaje.
  try {
    await notifier.sendNotice(buildNotice(row, roomFreed, newStatus), row?.guest_email);
  } catch (noticeError) {
    console.error("No se pudo publicar el aviso del cambio de estado:", noticeError);
  }

  return {
    reservationId: request.reservationId,
    previousStatus: null,
    status: row?.status ?? newStatus,
    roomFreed,
  };
}

function buildNotice(row, roomFreed, newStatus) {
  const room = row?.room_number ?? "(?)";
  const guest = row?.guest_name ?? "el huésped";
  if (newStatus === "CHECKED_OUT") {
    return `Check-out de ${guest} en la habitación ${room}.`;
  }
  if (newStatus === "CHECKED_IN") {
    return `Check-in de ${guest} en la habitación ${room}.`;
  }
  if (newStatus === "CANCELADA") {
    return `Reserva cancelada: ${guest} en la habitación ${room}.`;
  }
  return `La reserva ${row?.id} de ${guest} pasó a estado ${newStatus}.`;
}

module.exports = { changeStatus, buildNotice, MESSAGE_TYPE, RELEASES_ROOM };
