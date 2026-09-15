'use strict';

const http = require('http');
const socketIo = require('socket.io');
const originalCreateServer = http.createServer;
const OriginalSocketServer = socketIo.Server;
let capturedApp = null;
let capturedServer = null;
let capturedIo = null;

http.createServer = function patchedCreateServer(...args) {
  if (typeof args[0] === 'function') capturedApp = args[0];
  capturedServer = originalCreateServer.apply(this, args);
  return capturedServer;
};
socketIo.Server = class CapturedSocketServer extends OriginalSocketServer {
  constructor(...args) { super(...args); capturedIo = this; }
};

require('./server-v2');
http.createServer = originalCreateServer;
socketIo.Server = OriginalSocketServer;

function attachWithPriority(plugin, priority='api') {
  if (!capturedApp?._router?.stack) { plugin(capturedApp,{io:capturedIo,server:capturedServer}); return; }
  const stack=capturedApp._router.stack, before=stack.length;
  plugin(capturedApp,{io:capturedIo,server:capturedServer});
  const added=stack.splice(before);
  let index=-1;
  if(priority==='api') index=stack.findIndex(l=>l.route && String(l.route.path||'').startsWith('/api/'));
  if(index<0) index=stack.findIndex(l=>l.name==='serveStatic'||l.route?.path==='*');
  if(index<0) index=stack.length;
  stack.splice(index,0,...added);
}

if (!capturedApp) {
  console.error('[BOOTSTRAP_V4] Express app capture failed');
  process.exitCode = 1;
} else {
  attachWithPriority(require('./dispatcher-plugin'),'api');
  attachWithPriority((app)=>require('./r2-plugin')(app),'api');
  console.log('[BOOTSTRAP_V4] dispatcher + realtime tracker + payments + MongoDB + R2 loaded');
}

async function selfCheck(attempt=1){
  await new Promise(r=>setTimeout(r,5000));
  try{
    const port=Number(process.env.PORT||10000);
    const [health,storage]=await Promise.all([fetch(`http://127.0.0.1:${port}/health`).then(r=>r.json()),fetch(`http://127.0.0.1:${port}/api/storage/status`).then(async r=>({ok:r.ok,data:await r.json()}))]);
    if(health?.db==='mongodb')console.log('[V4] MongoDB verified');else console.warn('[V4] MongoDB not persistent');
    if(storage.ok&&storage.data?.reachable)console.log('[V4] R2 verified');else console.warn('[V4] R2 not reachable');
  }catch(e){if(attempt<3)return selfCheck(attempt+1);console.warn('[V4] self-check failed:',e.message);}
}
selfCheck();
