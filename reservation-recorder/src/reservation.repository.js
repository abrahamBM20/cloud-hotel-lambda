// Repository: único lugar que habla con la base de datos.
// Tabla 'reservations' (la crea y escribe esta Lambda) y tabla 'rooms' (la crea y
// escribe el microservicio ms-hotel-rooms; aquí solo se marca como ocupada).
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

// Red de seguridad: si la Lambda se despliega antes que el BFF, la tabla se crea sola.
// El BFF igual la crea con ddl-auto=update; CREATE TABLE IF NOT EXISTS no hace daño.
async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id            VARCHAR(64)  PRIMARY KEY,
      guest_name    VARCHAR(150) NOT NULL,
      guest_email   VARCHAR(200),
      guest_id      VARCHAR(200),
      room_number   VARCHAR(20)  NOT NULL,
      room_type     VARCHAR(30),
      check_in      DATE,
      check_out     DATE,
      guests        INTEGER      NOT NULL DEFAULT 1,
      total_amount  NUMERIC(12,2),
      status        VARCHAR(30)  NOT NULL DEFAULT 'PENDIENTE',
      notes         VARCHAR(500),
      requested_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ  DEFAULT now(),
      updated_at    TIMESTAMPTZ  DEFAULT now()
    );
  `);
}

// Idempotente: SQS entrega "al menos una vez", un reintento no duplica la reserva.
async function insertReservation(client, body) {
  const res = await client.query(
    `INSERT INTO reservations
       (id, guest_name, guest_email, guest_id, room_number, room_type,
        check_in, check_out, guests, total_amount, status, notes, requested_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
     ON CONFLICT (id) DO NOTHING
     RETURNING *;`,
    [
      body.reservationId,
      body.guestName,
      body.guestEmail ?? null,
      body.guestId ?? null,
      body.roomNumber,
      body.roomType ?? null,
      body.checkIn ?? null,
      body.checkOut ?? null,
      body.guests ?? 1,
      body.totalAmount ?? null,
      body.status ?? "PENDIENTE",
      body.notes ?? null,
      body.requestedAt ?? null,
    ],
  );
  return res.rows[0] ?? null;
}

// Recupera la reserva ya existente. Se usa cuando el insert no inserta nada
// (reintento de SQS) para devolver el estado real y no uno supuesto.
async function findReservation(client, reservationId) {
  const res = await client.query(
    `SELECT * FROM reservations WHERE id = $1;`,
    [reservationId],
  );
  return res.rows[0] ?? null;
}

// Marca la habitación como ocupada. El WHERE es la condición de carrera: si otra
// reserva se quedó con ella primero, no actualiza nada y devuelve 0 filas.
async function occupyRoom(client, roomNumber) {
  const res = await client.query(
    `UPDATE rooms
        SET is_available = false
      WHERE room_number = $1
        AND is_available = true
      RETURNING id;`,
    [roomNumber],
  );
  return res.rowCount > 0;
}

async function cancelReservation(client, reservationId, reason) {
  const res = await client.query(
    `UPDATE reservations
        SET status = 'CANCELADA',
            notes = COALESCE($2, notes),
            updated_at = now()
      WHERE id = $1
      RETURNING *;`,
    [reservationId, reason],
  );
  return res.rows[0] ?? null;
}

module.exports = { getPool, ensureSchema, insertReservation, findReservation, occupyRoom, cancelReservation };
