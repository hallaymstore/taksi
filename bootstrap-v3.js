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
