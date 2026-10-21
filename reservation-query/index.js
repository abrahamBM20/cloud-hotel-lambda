// Punto de entrada Lambda (handler = index.handler).
// La lógica vive en src/: handler (controller) → repository (DB).
module.exports = require("./src/handler");
