'use strict';

const http = require('http');
const originalCreateServer = http.createServer;
let capturedApp = null;

http.createServer = function patchedCreateServer(...args) {
  if (typeof args[0] === 'function') capturedApp = args[0];
  return originalCreateServer.apply(this, args);
};

require('./server-v2');
http.createServer = originalCreateServer;

if (!capturedApp) {
  console.error('[BOOTSTRAP_V3] Express app capture failed');
  process.exitCode = 1;
} else {
  require('./r2-plugin')(capturedApp);
  console.log('[BOOTSTRAP_V3] HALLAYM Taxi v2 + MongoDB + R2 extensions loaded');
}

async function verifyStorage(attempt = 1) {
  await new Promise(r => setTimeout(r, 5000));
  try {
    const port = Number(process.env.PORT || 10000);
    const r = await fetch(`http://127.0.0.1:${port}/api/storage/status`);
    const d = await r.json();
    if (r.ok && d.reachable) console.log('[R2] connectivity verified');
    else console.warn('[R2] connectivity check returned', r.status);
  } catch (e) {
    if (attempt < 3) return verifyStorage(attempt + 1);
    console.warn('[R2] connectivity self-check failed:', e.message);
  }
}
verifyStorage();
