// Repository: único lugar que habla con la base de datos.
// Actualiza la reserva en 'reservations' y libera la habitación en 'rooms'.
const { Pool } = require("pg");

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Supabase exige SSL; en local (Postgres sin SSL) se desactiva con DATABASE_SSL=false.
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
      max: 1,
    });
  }
  return pool;
}

async function findReservation(client, reservationId) {
  const res = await client.query(
    `SELECT * FROM reservations WHERE id = $1;`,
    [reservationId],
  );
  return res.rows[0] ?? null;
}

async function updateStatus(client, reservationId, newStatus, notes) {
  const res = await client.query(
    `UPDATE reservations
        SET status = $2,
            notes = COALESCE($3, notes),
            updated_at = now()
      WHERE id = $1
      RETURNING *;`,
    [reservationId, newStatus, notes ?? null],
  );
  return res.rows[0] ?? null;
}

// Devuelve la habitación a disponibilidad (check-out o cancelación).
async function freeRoom(client, roomNumber) {
  if (!roomNumber) {
    return false;
  }
  const res = await client.query(
    `UPDATE rooms
        SET is_available = true
      WHERE room_number = $1
      RETURNING id;`,
    [roomNumber],
  );
  return res.rowCount > 0;
}

module.exports = { getPool, findReservation, updateStatus, freeRoom };
