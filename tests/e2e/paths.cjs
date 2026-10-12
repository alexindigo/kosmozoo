// Docker defaults and explicitly injected native test workspace share one path port.
const path = require('node:path');
const workPath = (...parts) => path.join(process.env.E2E_WORKSPACE || '/work', ...parts);
const temporaryPath = (...parts) => path.join(process.env.TMPDIR || '/tmp', ...parts);
module.exports = { workPath, temporaryPath };
