const fs = require('node:fs');

function readSecret(name) {
  const filePath = process.env[`${name}_FILE`];
  const value = filePath
    ? fs.readFileSync(filePath, 'utf8').trim()
    : process.env[name];

  if (!value || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`${name} must be configured and contain at least 32 bytes.`);
  }
  return value;
}

function loadAuthConfig() {
  return {
    accessSecret: readSecret('JWT_ACCESS_SECRET'),
    refreshSecret: readSecret('JWT_REFRESH_SECRET'),
    issuer: process.env.JWT_ISSUER || 'barberpro-ai-crm',
    audience: process.env.JWT_AUDIENCE || 'barberpro-api',
    accessTtlSeconds: 15 * 60,
    refreshTtlSeconds: 7 * 24 * 60 * 60
  };
}

module.exports = { loadAuthConfig };
