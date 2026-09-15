'use strict';
const crypto = require('crypto');
if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = crypto.randomBytes(12).toString('base64url');
  console.log('[PREVIEW_ADMIN] A temporary admin password was generated for this process.');
  console.log('[PREVIEW_ADMIN_PASSWORD]', process.env.ADMIN_PASSWORD);
}
require('./server-v2');
