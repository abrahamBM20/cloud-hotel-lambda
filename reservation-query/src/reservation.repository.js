// Repository: único lugar que habla con la base de datos (lectura de 'reservations').
const { Pool, types } = require("pg");

// pg convierte DATE a un objeto Date en hora local; lo queremos como texto 'YYYY-MM-DD'
// para que el BFF lo mapee a LocalDate sin líos de zona horaria.
types.setTypeParser(types.builtins.DATE, (value) => value);

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

// Los alias en camelCase son los que consume el DTO del BFF (y el frontend).
const SELECT_COLUMNS = `
      id,
      guest_name  AS "guestName",
      guest_email AS "guestEmail",
      guest_id    AS "guestId",
      room_number AS "roomNumber",
      room_type   AS "roomType",
      check_in    AS "checkIn",
      check_out   AS "checkOut",
      guests,
      total_amount AS "totalAmount",
      status,
      notes,
      requested_at AS "requestedAt",
      created_at   AS "createdAt",
      updated_at   AS "updatedAt"
`;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Lista las reservas aplicando los filtros que le manda el BFF.
 * Filtros: id, status, roomNumber, guestId, guestEmail, from, to, limit.
 */
async function listReservations(filters = {}) {
  const clauses = [];
  const values = [];

  const add = (sql, value) => {
    values.push(value);
    clauses.push(sql.replace("?", `$${values.length}`));
  };

  if (filters.id) add("id = ?", filters.id);
  if (filters.status) add("status = ?", String(filters.status).toUpperCase());
  if (filters.roomNumber) add("room_number = ?", filters.roomNumber);
  if (filters.guestId) add("guest_id = ?", filters.guestId);
  if (filters.guestEmail) add("guest_email = ?", filters.guestEmail);
  if (filters.from) add("check_in >= ?", filters.from);
  if (filters.to) add("check_in <= ?", filters.to);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const limit = Math.min(
    Math.max(parseInt(filters.limit, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  values.push(limit);

  const { rows } = await getPool().query(
    `SELECT ${SELECT_COLUMNS}
       FROM reservations
       ${where}
      ORDER BY requested_at DESC NULLS LAST, created_at DESC
      LIMIT $${values.length};`,
    values,
  );
  return rows;
}

module.exports = { listReservations, getPool };
