# cloud-hotel-lambda

Funciones Lambda del Hotel Boutique 360. Son la capa de eventos que el BFF (`cloud-hotel-bff`)
dispara para crear y modificar reservas.

| Carpeta | Lambda | Disparador | Rol |
|---|---|---|---|
| `reservation-recorder/` | `reservation-recorder` | SQS `reservation-requests` | Crea la reserva y ocupa la habitación |
| `reservation-status-updater/` | `reservation-status-updater` | SQS `reservation-status` | Check-in, check-out y cancelación |
| `reservation-query/` | `reservation-query` | Function URL | **Lectura**: devuelve el JSON de las reservas |

La infra de AWS (topic SNS, colas, FilterPolicies, IAM) está en **[DEPLOY.md](./DEPLOY.md)**.
La guía completa de Vercel, EC2, API Gateway, Cognito, Supabase, SES y GitHub Actions
está en **[GUIA-IMPLEMENTACION-AWS.md](../GUIA-IMPLEMENTACION-AWS.md)**.

---

## El flujo completo

```
Frontend ──▶ API Gateway ──▶ cloud-hotel-bff
                              │
    escritura (POST/PATCH)    │  SNS  hotel-reservation-events
                              ▼
                              ├─▶ SQS reservation-requests ──▶ reservation-recorder ──▶ PostgreSQL
                              │                                                       (reservations + rooms.is_available)
                              └─▶ SQS reservation-status  ──▶ reservation-status-updater ──▶ PostgreSQL

    lectura (GET)             │  Function URL
                              ▼
                              reservation-query ──▶ PostgreSQL ──▶ JSON ──▶ BFF ──▶ Frontend
```

## El mensaje

El BFF publica en el topic SNS con el formato `{type, body}`:

```json
{
  "type": "reservation.requested",
  "body": {
    "reservationId": "6f1c...",
    "guestName": "Carlos Mendoza",
    "guestEmail": "carlos@hotel.cl",
    "guestId": "sub-de-cognito",
    "roomNumber": "101",
    "roomType": "DOUBLE",
    "checkIn": "2026-11-01",
    "checkOut": "2026-11-03",
    "guests": 2,
    "totalAmount": 240.00,
    "status": "PENDIENTE",
    "notes": "",
    "requestedAt": "2026-10-21T12:00:00Z",
    "requestedBy": "carlos@hotel.cl"
  }
}
```

El segundo tipo es `reservation.status-changed`:

```json
{
  "type": "reservation.status-changed",
  "body": {
    "reservationId": "6f1c...",
    "newStatus": "CHECKED_IN",
    "notes": "",
    "changedBy": "recepcion@hotel.cl",
    "changedAt": "2026-10-21T12:05:00Z"
  }
}
```

La FilterPolicy de cada cola deja pasar solo su tipo, así que cada Lambda recibe lo suyo.

---

## Estructura de cada Lambda

Siguiendo el patrón de `cloud-lambda-pg`:

```
reservation-recorder/
├── index.js                  -> punto de entrada (handler = index.handler)
├── package.json
└── src/
    ├── handler.js            -> controller: lee SQS, valida el tipo, delega
    ├── reservation.service.js-> negocio: validar -> insertar -> ocupar -> avisar
    ├── reservation.repository.js -> único lugar que habla con PostgreSQL
    └── notifier.js           -> publica el aviso en la API de notificaciones
```

## Idempotencia

SQS entrega "al menos una vez": un mensaje puede llegar dos veces.

- `reservation-recorder` inserta con `ON CONFLICT (id) DO NOTHING`: un reintento no duplica la reserva.
- `reservation-status-updater` hace `UPDATE` (no `INSERT`): reintentar es seguro.
- La reserva y la ocupación de la habitación van en la **misma transacción**: si la Lambda falla,
  no queda una reserva sin habitación ocupada (ni al revés).

## La carrera de dos reservas por la misma habitación

El BFF valida que la habitación esté disponible, pero entre esa validación y el insert otra
reserva puede ocupar la misma habitación. Por eso el `UPDATE` de `rooms` es condicional:

```sql
UPDATE rooms SET is_available = false
 WHERE room_number = $1 AND is_available = true
 RETURNING id;
```

Si no actualiza ninguna fila, la habitación ya no está disponible: la reserva se guarda con
estado `CANCELADA` y se avisa. No se pierde ni se duplica la habitación.

## La Lambda de lectura

`reservation-query` no es un trigger de SQS: se publica con una **Function URL** y la invoca el
BFF. Recibe el evento en formato AWS_PROXY:

```json
{
  "httpMethod": "GET",
  "path": "/reservations",
  "queryStringParameters": { "status": "PENDIENTE", "limit": "50" }
}
```

y responde:

```json
{ "statusCode": 200, "headers": { "Content-Type": "application/json" }, "body": "[ ... ]" }
```

El handler contempla las dos formas en que llega el evento: invocación directa (consola de
Lambda) y a través de la Function URL (donde el payload viaja dentro de `event.body`).
Además exige `X-Internal-Query-Token`; el frontend nunca llama esta URL directamente.

## Correo con EmailJS

`reservation-recorder` y `reservation-status-updater` utilizan EmailJS cuando:

```env
NOTIFY_MODE=emailjs
EMAILJS_SERVICE_ID=service_xxxxx
EMAILJS_TEMPLATE_ID=template_xxxxx
EMAILJS_PUBLIC_KEY=tu_public_key
EMAILJS_PRIVATE_KEY=tu_private_key
```

`EMAILJS_PRIVATE_KEY` es opcional, pero se recomienda configurarlo en Lambda como
`accessToken`. El template debe usar al menos las variables `{{to_email}}`,
`{{subject}}` y `{{message}}`. El remitente se configura dentro del servicio de
correo conectado a EmailJS; no se necesita permiso adicional de IAM.

---

## Desarrollo local

```bash
cd reservation-recorder
npm install
npm test          # solo verifica la sintaxis de los archivos
```

Para probar el flujo completo en local hay que levantar el Postgres y el BFF. Ver el
README de `cloud-hotel-bff`.

## Despliegue

Ver **[DEPLOY.md](./DEPLOY.md)**: creación del topic, las colas, las FilterPolicies, las
Lambdas, el IAM, los secrets de GitHub y los comandos de prueba.
