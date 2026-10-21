// Punto de entrada Lambda (handler = index.handler).
// La lógica vive en src/: handler (controller) → service (negocio) → repository (DB).
module.exports = require("./src/handler");
