'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
const MONGODB_URI = process.env.MONGODB_URI || '';
const APP_NAME = process.env.APP_NAME || 'HALLAYM Taxi';
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || '+998900000001');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const NOMINATIM_USER_AGENT = process.env.NOMINATIM_USER_AGENT || 'HALLAYM-Taxi/2.0 (contact: hallaymstore@gmail.com)';
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';

function normalizePhone(v = '') {
  const digits = String(v).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 9) return `+998${digits}`;
  if (digits.startsWith('998')) return `+${digits}`;
  return `+${digits}`;
}
function safeText(v, max = 180) { return String(v ?? '').trim().slice(0, max); }
function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || 0)); }
function idOf(v) { return String(v?._id || v?.id || v || ''); }
function nowIso() { return new Date().toISOString(); }
function haversineKm(a, b) {
  if (!a || !b || !Number.isFinite(Number(a.lat)) || !Number.isFinite(Number(a.lng)) || !Number.isFinite(Number(b.lat)) || !Number.isFinite(Number(b.lng))) return 0;
  const R = 6371, dLat = (Number(b.lat)-Number(a.lat))*Math.PI/180, dLng=(Number(b.lng)-Number(a.lng))*Math.PI/180;
  const x = Math.sin(dLat/2)**2 + Math.cos(Number(a.lat)*Math.PI/180)*Math.cos(Number(b.lat)*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function publicUser(u) {
  if (!u) return null;
  return { id:idOf(u), name:u.name, phone:u.phone, email:u.email||'', role:u.role, status:u.status, avatar:u.avatar||'', walletBalance:Number(u.walletBalance||0), language:u.language||'uz', emergencyName:u.emergencyName||'', emergencyPhone:u.emergencyPhone||'', favoritePlaces:u.favoritePlaces||[], createdAt:u.createdAt };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors:{ origin:true, credentials:true } });
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy:false, crossOriginEmbedderPolicy:false }));
app.use(cors({ origin:true, credentials:true }));
app.use(express.json({ limit:'1mb' }));
app.use(express.urlencoded({ extended:true, limit:'1mb' }));
app.use('/api/auth', rateLimit({ windowMs:60_000, max:35, standardHeaders:true, legacyHeaders:false }));
app.use('/api/geocode', rateLimit({ windowMs:60_000, max:45, standardHeaders:true, legacyHeaders:false }));
app.use('/api/route', rateLimit({ windowMs:60_000, max:60, standardHeaders:true, legacyHeaders:false }));

let mongoReady = false;
const memory = { users:[], drivers:[], rides:[], promos:[], notifications:[], tickets:[], transactions:[], settings:null };

const pointSchema = new mongoose.Schema({ label:String, lat:Number, lng:Number }, { _id:false });
const favoriteSchema = new mongoose.Schema({ name:String, label:String, lat:Number, lng:Number }, { _id:false });
const userSchema = new mongoose.Schema({
  name:{type:String,required:true,trim:true}, phone:{type:String,required:true,unique:true,index:true}, email:{type:String,default:''}, passwordHash:{type:String,required:true},
  role:{type:String,enum:['client','driver','admin'],default:'client',index:true}, status:{type:String,enum:['active','blocked'],default:'active'}, avatar:{type:String,default:''},
  walletBalance:{type:Number,default:0}, language:{type:String,default:'uz'}, emergencyName:{type:String,default:''}, emergencyPhone:{type:String,default:''}, favoritePlaces:{type:[favoriteSchema],default:[]}
}, { timestamps:true });
const driverSchema = new mongoose.Schema({
  userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',unique:true,index:true}, carMake:String, carModel:String, carColor:String, plate:String, licenseNo:String,
  vehicleClass:{type:String,enum:['economy','comfort','business'],default:'economy'}, approved:{type:Boolean,default:false}, online:{type:Boolean,default:false},
  location:{lat:Number,lng:Number}, rating:{type:Number,default:5}, completedRides:{type:Number,default:0}, totalEarnings:{type:Number,default:0},
  documentStatus:{type:String,enum:['missing','pending','approved','rejected'],default:'missing'}, documentNote:{type:String,default:''}, lastOnlineAt:Date
}, { timestamps:true });
const rideSchema = new mongoose.Schema({
  clientId:{type:mongoose.Schema.Types.ObjectId,ref:'User',index:true}, driverId:{type:mongoose.Schema.Types.ObjectId,ref:'User',default:null,index:true},
  pickup:pointSchema, destination:pointSchema, vehicleClass:{type:String,enum:['economy','comfort','business'],default:'economy'}, paymentMethod:{type:String,enum:['cash','click','payme','wallet'],default:'cash'},
  paymentStatus:{type:String,enum:['unpaid','pending','paid','failed'],default:'unpaid'}, distanceKm:Number, durationMin:Number, fare:Number, originalFare:Number, discount:{type:Number,default:0}, promoCode:String,
  note:String, passengerName:String, passengerPhone:String, scheduledFor:Date,
  status:{type:String,enum:['pending','accepted','arrived','in_progress','completed','cancelled'],default:'pending',index:true}, cancelReason:String, rating:Number, feedback:String,
  sos:{type:Boolean,default:false}, acceptedAt:Date, arrivedAt:Date, startedAt:Date, completedAt:Date, cancelledAt:Date
}, { timestamps:true });
const settingsSchema = new mongoose.Schema({
  key:{type:String,default:'pricing',unique:true}, baseFare:{type:Number,default:5000}, perKm:{type:Number,default:2500}, perMinute:{type:Number,default:250}, minimumFare:{type:Number,default:7000}, serviceFee:{type:Number,default:0},
  economyMultiplier:{type:Number,default:1}, comfortMultiplier:{type:Number,default:1.35}, businessMultiplier:{type:Number,default:1.8}, surgeMultiplier:{type:Number,default:1}, commissionPercent:{type:Number,default:12}, cancellationFee:{type:Number,default:3000}, city:{type:String,default:'Qarshi'}
}, { timestamps:true });
const promoSchema = new mongoose.Schema({ code:{type:String,unique:true,index:true}, type:{type:String,enum:['percent','fixed'],default:'percent'}, value:Number, maxDiscount:{type:Number,default:0}, active:{type:Boolean,default:true}, usageLimit:{type:Number,default:0}, usedCount:{type:Number,default:0}, expiresAt:Date }, { timestamps:true });
const notificationSchema = new mongoose.Schema({ userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',index:true}, title:String, body:String, type:{type:String,default:'info'}, read:{type:Boolean,default:false} }, { timestamps:true });
const ticketSchema = new mongoose.Schema({ userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',index:true}, subject:String, message:String, status:{type:String,enum:['open','in_progress','closed'],default:'open'}, priority:{type:String,enum:['low','normal','high'],default:'normal'}, adminReply:{type:String,default:''} }, { timestamps:true });
const transactionSchema = new mongoose.Schema({ userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',index:true}, rideId:{type:mongoose.Schema.Types.ObjectId,ref:'Ride',default:null}, type:{type:String,enum:['topup','ride','refund','earning'],required:true}, amount:Number, status:{type:String,default:'completed'}, description:String }, { timestamps:true });

const User=mongoose.model('User',userSchema), Driver=mongoose.model('Driver',driverSchema), Ride=mongoose.model('Ride',rideSchema), Settings=mongoose.model('Settings',settingsSchema), Promo=mongoose.model('Promo',promoSchema), Notification=mongoose.model('Notification',notificationSchema), Ticket=mongoose.model('Ticket',ticketSchema), Transaction=mongoose.model('Transaction',transactionSchema);

function defaultSettings(){ return { key:'pricing', baseFare:5000, perKm:2500, perMinute:250, minimumFare:7000, serviceFee:0, economyMultiplier:1, comfortMultiplier:1.35, businessMultiplier:1.8, surgeMultiplier:1, commissionPercent:12, cancellationFee:3000, city:'Qarshi' }; }
async function initData(){
  if (mongoReady) {
    await Settings.findOneAndUpdate({key:'pricing'},{$setOnInsert:defaultSettings()},{upsert:true,new:true});
    await Promo.findOneAndUpdate({code:'WELCOME10'},{$setOnInsert:{code:'WELCOME10',type:'percent',value:10,maxDiscount:10000,active:true,usageLimit:0,usedCount:0}},{upsert:true,new:true});
    if (ADMIN_PASSWORD) {
      const hash=await bcrypt.hash(ADMIN_PASSWORD,10); let admin=await User.findOne({role:'admin'});
      if(!admin) await User.create({name:'HALLAYM Admin',phone:ADMIN_PHONE,passwordHash:hash,role:'admin'});
    }
    return;
  }
  memory.settings ||= defaultSettings();
  if (!memory.promos.length) memory.promos.push({id:crypto.randomUUID(),code:'WELCOME10',type:'percent',value:10,maxDiscount:10000,active:true,usageLimit:0,usedCount:0,createdAt:nowIso()});
  if (ADMIN_PASSWORD && !memory.users.some(u=>u.role==='admin')) {
    memory.users.push({id:crypto.randomUUID(),name:'HALLAYM Admin',phone:ADMIN_PHONE,email:'',passwordHash:await bcrypt.hash(ADMIN_PASSWORD,10),role:'admin',status:'active',avatar:'',walletBalance:0,language:'uz',emergencyName:'',emergencyPhone:'',favoritePlaces:[],createdAt:nowIso()});
  }
}
async function connectDatabase(){
  if(!MONGODB_URI){ console.warn('[DB] MONGODB_URI missing: temporary in-memory mode'); await initData(); return; }
  try{ await mongoose.connect(MONGODB_URI,{serverSelectionTimeoutMS:9000}); mongoReady=true; console.log('[DB] MongoDB connected'); }catch(e){ console.error('[DB] MongoDB unavailable:',e.message); }
  await initData();
}
async function findUserByPhone(phone){ return mongoReady?User.findOne({phone}):memory.users.find(u=>u.phone===phone)||null; }
async function findUserById(id){ if(!id)return null; if(mongoReady){try{return await User.findById(id);}catch{return null;}} return memory.users.find(u=>idOf(u)===String(id))||null; }
async function getSettings(){ return mongoReady?((await Settings.findOne({key:'pricing'}).lean())||defaultSettings()):{...memory.settings}; }
function tokenFor(u){ return jwt.sign({sub:idOf(u),role:u.role},JWT_SECRET,{expiresIn:'30d'}); }
function auth(req,res,next){ const raw=req.headers.authorization||'', t=raw.startsWith('Bearer ')?raw.slice(7):''; if(!t)return res.status(401).json({error:'Avtorizatsiya talab qilinadi'}); try{req.auth=jwt.verify(t,JWT_SECRET);next();}catch{return res.status(401).json({error:'Sessiya yaroqsiz yoki muddati tugagan'});} }
function role(...roles){ return (req,res,next)=>roles.includes(req.auth?.role)?next():res.status(403).json({error:'Ruxsat yetarli emas'}); }
async function ensureActive(req,res,next){ const u=await findUserById(req.auth.sub); if(!u||u.status!=='active')return res.status(403).json({error:'Akkaunt bloklangan yoki topilmadi'}); req.user=u; next(); }

async function notify(userId,title,body,type='info'){
  if(!userId)return; let n;
  if(mongoReady) n=(await Notification.create({userId,title,body,type})).toObject(); else {n={id:crypto.randomUUID(),userId:idOf(userId),title,body,type,read:false,createdAt:nowIso()};memory.notifications.unshift(n);}
  io.to(`user:${idOf(userId)}`).emit('notification:new',n);
}

const routeCache=new Map();
async function roadRoute(a,b){
  const key=[a.lng,a.lat,b.lng,b.lat].map(x=>Number(x).toFixed(4)).join(','); const cached=routeCache.get(key); if(cached&&Date.now()-cached.at<120000)return cached.data;
  try{
    const url=`${OSRM_URL.replace(/\/$/,'')}/route/v1/driving/${Number(a.lng)},${Number(a.lat)};${Number(b.lng)},${Number(b.lat)}?overview=full&geometries=geojson&steps=false`;
    const r=await fetch(url,{headers:{'User-Agent':NOMINATIM_USER_AGENT}}); if(!r.ok)throw new Error(`OSRM ${r.status}`); const j=await r.json(); const x=j.routes?.[0]; if(!x)throw new Error('route unavailable');
    const data={distanceKm:Number((x.distance/1000).toFixed(2)),durationMin:Math.max(1,Math.round(x.duration/60)),geometry:x.geometry}; routeCache.set(key,{at:Date.now(),data}); return data;
  }catch{
    const km=Math.max(.3,haversineKm(a,b)*1.18); return {distanceKm:Number(km.toFixed(2)),durationMin:Math.max(2,Math.round(km/28*60)),geometry:{type:'LineString',coordinates:[[Number(a.lng),Number(a.lat)],[Number(b.lng),Number(b.lat)]]},fallback:true};
  }
}
function classMult(k,s){ return Number(k==='business'?s.businessMultiplier:k==='comfort'?s.comfortMultiplier:s.economyMultiplier||1); }
function calcFare(distanceKm,durationMin,klass,s){ return Math.ceil(Math.max(Number(s.minimumFare||0),(Number(s.baseFare||0)+distanceKm*Number(s.perKm||0)+durationMin*Number(s.perMinute||0)+Number(s.serviceFee||0))*classMult(klass,s)*Number(s.surgeMultiplier||1))/500)*500; }
async function findPromo(code){ const c=safeText(code,32).toUpperCase(); if(!c)return null; return mongoReady?Promo.findOne({code:c}).lean():memory.promos.find(p=>p.code===c)||null; }
function promoValid(p){ if(!p||!p.active)return false; if(p.expiresAt&&new Date(p.expiresAt)<new Date())return false; if(Number(p.usageLimit||0)>0&&Number(p.usedCount||0)>=Number(p.usageLimit))return false; return true; }
function promoDiscount(p,fare){ if(!promoValid(p))return 0; const raw=p.type==='fixed'?Number(p.value||0):fare*Number(p.value||0)/100; return Math.max(0,Math.min(raw,Number(p.maxDiscount||0)>0?Number(p.maxDiscount):raw,fare)); }

app.get('/health',(_q,res)=>res.json({ok:true,app:APP_NAME,db:mongoReady?'mongodb':'memory',version:'2.0',time:nowIso()}));
app.get('/api/meta',async(_q,res)=>res.json({appName:APP_NAME,persistence:mongoReady?'mongodb':'memory',version:'2.0',mapProvider:'OpenFreeMap',features:['realtime','routing','promo','favorites','support','earnings','live-admin']}));

app.post('/api/auth/register',async(req,res)=>{try{
  const name=safeText(req.body.name,80), phone=normalizePhone(req.body.phone), password=String(req.body.password||''), requestedRole=req.body.role==='driver'?'driver':'client';
  if(name.length<2||phone.length<10||password.length<6)return res.status(400).json({error:'Ism, telefon va kamida 6 belgili parol kiriting'}); if(await findUserByPhone(phone))return res.status(409).json({error:'Bu telefon raqam allaqachon ro‘yxatdan o‘tgan'});
  const passwordHash=await bcrypt.hash(password,10); let u;
  if(mongoReady){u=await User.create({name,phone,email:safeText(req.body.email,120),passwordHash,role:requestedRole}); if(requestedRole==='driver')await Driver.create({userId:u._id});}
  else {u={id:crypto.randomUUID(),name,phone,email:safeText(req.body.email,120),passwordHash,role:requestedRole,status:'active',avatar:'',walletBalance:0,language:'uz',emergencyName:'',emergencyPhone:'',favoritePlaces:[],createdAt:nowIso()};memory.users.push(u);if(requestedRole==='driver')memory.drivers.push({id:crypto.randomUUID(),userId:u.id,carMake:'',carModel:'',carColor:'',plate:'',licenseNo:'',vehicleClass:'economy',approved:false,online:false,location:null,rating:5,completedRides:0,totalEarnings:0,documentStatus:'missing'});}
  await notify(idOf(u),'Xush kelibsiz','HALLAYM Taxi akkauntingiz yaratildi.','success'); res.status(201).json({token:tokenFor(u),user:publicUser(u)});
}catch(e){res.status(500).json({error:'Ro‘yxatdan o‘tishda xato',detail:e.message});}});
app.post('/api/auth/login',async(req,res)=>{try{const phone=normalizePhone(req.body.phone),u=await findUserByPhone(phone);if(!u||!(await bcrypt.compare(String(req.body.password||''),u.passwordHash)))return res.status(401).json({error:'Telefon yoki parol noto‘g‘ri'});if(u.status!=='active')return res.status(403).json({error:'Akkaunt bloklangan'});res.json({token:tokenFor(u),user:publicUser(u)});}catch(e){res.status(500).json({error:'Kirishda xato',detail:e.message});}});

app.get('/api/me',auth,ensureActive,async(req,res)=>{let driver=null;if(req.user.role==='driver')driver=mongoReady?await Driver.findOne({userId:req.user._id}).lean():memory.drivers.find(d=>idOf(d.userId)===idOf(req.user));res.json({user:publicUser(req.user),driver});});
app.patch('/api/me',auth,ensureActive,async(req,res)=>{const patch={name:safeText(req.body.name||req.user.name,80),avatar:safeText(req.body.avatar??req.user.avatar,500),language:['uz','ru','en'].includes(req.body.language)?req.body.language:(req.user.language||'uz'),emergencyName:safeText(req.body.emergencyName??req.user.emergencyName,80),emergencyPhone:normalizePhone(req.body.emergencyPhone??req.user.emergencyPhone)};if(mongoReady)req.user=await User.findByIdAndUpdate(req.user._id,patch,{new:true});else Object.assign(req.user,patch);res.json({user:publicUser(req.user)});});
app.get('/api/me/favorites',auth,ensureActive,async(req,res)=>res.json(req.user.favoritePlaces||[]));
app.post('/api/me/favorites',auth,ensureActive,async(req,res)=>{const p={name:safeText(req.body.name,30)||'Joy',label:safeText(req.body.label,180),lat:Number(req.body.lat),lng:Number(req.body.lng)};if(!Number.isFinite(p.lat)||!Number.isFinite(p.lng))return res.status(400).json({error:'Koordinata noto‘g‘ri'});let fav=[...(req.user.favoritePlaces||[])].filter(x=>String(x.name).toLowerCase()!==p.name.toLowerCase()).slice(0,9);fav.unshift(p);if(mongoReady)req.user=await User.findByIdAndUpdate(req.user._id,{favoritePlaces:fav},{new:true});else req.user.favoritePlaces=fav;res.status(201).json(req.user.favoritePlaces||fav);});
app.delete('/api/me/favorites/:name',auth,ensureActive,async(req,res)=>{const n=decodeURIComponent(req.params.name).toLowerCase();const fav=(req.user.favoritePlaces||[]).filter(x=>String(x.name).toLowerCase()!==n);if(mongoReady)req.user=await User.findByIdAndUpdate(req.user._id,{favoritePlaces:fav},{new:true});else req.user.favoritePlaces=fav;res.json(req.user.favoritePlaces||fav);});

app.get('/api/pricing',async(_q,res)=>res.json(await getSettings()));
app.get('/api/route',async(req,res)=>{const a={lat:Number(req.query.fromLat),lng:Number(req.query.fromLng)},b={lat:Number(req.query.toLat),lng:Number(req.query.toLng)};if(![a.lat,a.lng,b.lat,b.lng].every(Number.isFinite))return res.status(400).json({error:'Koordinata noto‘g‘ri'});res.json(await roadRoute(a,b));});
app.get('/api/drivers/nearby',auth,ensureActive,async(req,res)=>{const lat=Number(req.query.lat),lng=Number(req.query.lng),klass=safeText(req.query.class,20);if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.json({count:0,etaMin:null});let ds=mongoReady?await Driver.find({approved:true,online:true,location:{$exists:true}}).lean():memory.drivers.filter(d=>d.approved&&d.online&&d.location);if(klass)ds=ds.filter(d=>!d.vehicleClass||d.vehicleClass===klass||klass==='economy');const km=ds.map(d=>haversineKm({lat,lng},d.location)).filter(Number.isFinite).sort((a,b)=>a-b);res.json({count:km.filter(x=>x<=15).length,etaMin:km.length?Math.max(2,Math.round(km[0]/25*60)):null,nearestKm:km.length?Number(km[0].toFixed(1)):null});});
app.get('/api/promos/:code',auth,ensureActive,async(req,res)=>{const p=await findPromo(req.params.code);if(!promoValid(p))return res.status(404).json({error:'Promo kod yaroqsiz yoki muddati tugagan'});res.json({code:p.code,type:p.type,value:p.value,maxDiscount:p.maxDiscount||0});});

app.get('/api/driver/profile',auth,role('driver'),ensureActive,async(req,res)=>{const d=mongoReady?await Driver.findOne({userId:req.user._id}).lean():memory.drivers.find(x=>idOf(x.userId)===idOf(req.user));res.json(d||{});});
app.put('/api/driver/profile',auth,role('driver'),ensureActive,async(req,res)=>{const patch={carMake:safeText(req.body.carMake,60),carModel:safeText(req.body.carModel,60),carColor:safeText(req.body.carColor,40),plate:safeText(req.body.plate,20).toUpperCase(),licenseNo:safeText(req.body.licenseNo,40),vehicleClass:['economy','comfort','business'].includes(req.body.vehicleClass)?req.body.vehicleClass:'economy',documentStatus:'pending'};let d;if(mongoReady)d=await Driver.findOneAndUpdate({userId:req.user._id},patch,{new:true,upsert:true}).lean();else{d=memory.drivers.find(x=>idOf(x.userId)===idOf(req.user));if(!d){d={id:crypto.randomUUID(),userId:idOf(req.user),approved:false,online:false,rating:5,completedRides:0,totalEarnings:0};memory.drivers.push(d);}Object.assign(d,patch);}io.to('role:admin').emit('admin:refresh');res.json(d);});
app.patch('/api/driver/online',auth,role('driver'),ensureActive,async(req,res)=>{let d=mongoReady?await Driver.findOne({userId:req.user._id}):memory.drivers.find(x=>idOf(x.userId)===idOf(req.user));if(!d?.approved&&req.body.online)return res.status(403).json({error:'Admin tasdiqlamaguncha onlayn bo‘lib bo‘lmaydi'});if(mongoReady){d.online=!!req.body.online;d.lastOnlineAt=new Date();await d.save();}else{d.online=!!req.body.online;d.lastOnlineAt=nowIso();}io.to('role:admin').emit('driver:presence',{userId:idOf(req.user),online:d.online,location:d.location});res.json({online:d.online});});
app.patch('/api/driver/location',auth,role('driver'),ensureActive,async(req,res)=>{const lat=Number(req.body.lat),lng=Number(req.body.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({error:'Koordinata xato'});let d=mongoReady?await Driver.findOneAndUpdate({userId:req.user._id},{location:{lat,lng}},{new:true}):memory.drivers.find(x=>idOf(x.userId)===idOf(req.user));if(!mongoReady&&d)d.location={lat,lng};const active=mongoReady?await Ride.findOne({driverId:req.user._id,status:{$in:['accepted','arrived','in_progress']}}).lean():memory.rides.find(r=>idOf(r.driverId)===idOf(req.user)&&['accepted','arrived','in_progress'].includes(r.status));if(active)io.to(`user:${idOf(active.clientId)}`).emit('driver:location',{rideId:idOf(active),lat,lng});io.to('role:admin').emit('driver:location',{userId:idOf(req.user),lat,lng});res.json({ok:true});});
app.get('/api/driver/stats',auth,role('driver'),ensureActive,async(req,res)=>{const settings=await getSettings();let rides=mongoReady?await Ride.find({driverId:req.user._id,status:'completed'}).lean():memory.rides.filter(r=>idOf(r.driverId)===idOf(req.user)&&r.status==='completed');const now=new Date(),day=new Date(now);day.setHours(0,0,0,0);const week=new Date(now);week.setDate(now.getDate()-7);const month=new Date(now);month.setDate(now.getDate()-30);const sum=xs=>xs.reduce((a,r)=>a+Number(r.fare||0),0);const net=v=>Math.round(v*(1-Number(settings.commissionPercent||0)/100));res.json({completed:rides.length,gross:sum(rides),net:net(sum(rides)),today:net(sum(rides.filter(r=>new Date(r.completedAt||r.updatedAt||r.createdAt)>=day))),week:net(sum(rides.filter(r=>new Date(r.completedAt||r.updatedAt||r.createdAt)>=week))),month:net(sum(rides.filter(r=>new Date(r.completedAt||r.updatedAt||r.createdAt)>=month))),commissionPercent:Number(settings.commissionPercent||0)});});

app.post('/api/rides',auth,role('client'),ensureActive,async(req,res)=>{try{
  const p=req.body.pickup||{},d=req.body.destination||{},pickup={label:safeText(p.label,180),lat:Number(p.lat),lng:Number(p.lng)},destination={label:safeText(d.label,180),lat:Number(d.lat),lng:Number(d.lng)};
  if(![pickup.lat,pickup.lng,destination.lat,destination.lng].every(Number.isFinite))return res.status(400).json({error:'Jo‘nash va manzil nuqtalarini tanlang'});
  const existing=mongoReady?await Ride.findOne({clientId:req.user._id,status:{$in:['pending','accepted','arrived','in_progress']}}):memory.rides.find(r=>idOf(r.clientId)===idOf(req.user)&&['pending','accepted','arrived','in_progress'].includes(r.status));if(existing)return res.status(409).json({error:'Sizda allaqachon faol buyurtma bor',rideId:idOf(existing)});
  const settings=await getSettings(), route=await roadRoute(pickup,destination),vehicleClass=['economy','comfort','business'].includes(req.body.vehicleClass)?req.body.vehicleClass:'economy'; const originalFare=calcFare(route.distanceKm,route.durationMin,vehicleClass,settings);
  let promo=null,discount=0;if(req.body.promoCode){promo=await findPromo(req.body.promoCode);discount=promoDiscount(promo,originalFare);} const fare=Math.max(0,originalFare-discount);
  const scheduled= req.body.scheduledFor ? new Date(req.body.scheduledFor) : null; if(scheduled&&Number.isNaN(scheduled.getTime()))return res.status(400).json({error:'Rejalashtirilgan vaqt noto‘g‘ri'});
  const paymentMethod=['cash','click','payme','wallet'].includes(req.body.paymentMethod)?req.body.paymentMethod:'cash'; if(paymentMethod==='wallet'&&Number(req.user.walletBalance||0)<fare)return res.status(400).json({error:'Hamyon balansida mablag‘ yetarli emas'});
  const rideData={clientId:mongoReady?req.user._id:idOf(req.user),driverId:null,pickup,destination,vehicleClass,paymentMethod,paymentStatus:paymentMethod==='cash'?'unpaid':paymentMethod==='wallet'?'paid':'pending',distanceKm:route.distanceKm,durationMin:route.durationMin,fare,originalFare,discount,promoCode:promoValid(promo)?promo.code:'',note:safeText(req.body.note,240),passengerName:safeText(req.body.passengerName,80),passengerPhone:normalizePhone(req.body.passengerPhone),scheduledFor:scheduled||null,status:'pending',sos:false,createdAt:nowIso()};
  let ride;if(mongoReady){ride=await Ride.create(rideData);if(paymentMethod==='wallet'){await User.updateOne({_id:req.user._id},{$inc:{walletBalance:-fare}});await Transaction.create({userId:req.user._id,rideId:ride._id,type:'ride',amount:-fare,description:'Taksi safari'});}if(promoValid(promo))await Promo.updateOne({_id:promo._id},{$inc:{usedCount:1}});}else{ride={id:crypto.randomUUID(),...rideData};memory.rides.unshift(ride);if(paymentMethod==='wallet')req.user.walletBalance=Number(req.user.walletBalance||0)-fare;if(promoValid(promo))promo.usedCount=Number(promo.usedCount||0)+1;}
  io.to('role:driver').emit('ride:new',ride);io.to('role:admin').emit('admin:refresh');await notify(idOf(req.user),'Buyurtma qabul qilindi',`${pickup.label} → ${destination.label}`,'ride');res.status(201).json(ride);
}catch(e){res.status(500).json({error:'Buyurtma yaratishda xato',detail:e.message});}});

app.get('/api/rides/mine',auth,ensureActive,async(req,res)=>{let rides;if(mongoReady){const q=req.user.role==='client'?{clientId:req.user._id}:req.user.role==='driver'?{driverId:req.user._id}:{};rides=await Ride.find(q).sort({createdAt:-1}).limit(150).lean();}else rides=memory.rides.filter(r=>req.user.role==='admin'||(req.user.role==='client'?idOf(r.clientId)===idOf(req.user):idOf(r.driverId)===idOf(req.user))).slice(0,150);res.json(rides);});
app.get('/api/rides/:id/details',auth,ensureActive,async(req,res)=>{let r=mongoReady?await Ride.findById(req.params.id).lean():memory.rides.find(x=>idOf(x)===req.params.id);if(!r)return res.status(404).json({error:'Buyurtma topilmadi'});const uid=idOf(req.user);if(req.user.role!=='admin'&&uid!==idOf(r.clientId)&&uid!==idOf(r.driverId))return res.status(403).json({error:'Ruxsat yo‘q'});const client=await findUserById(r.clientId),driverUser=r.driverId?await findUserById(r.driverId):null;let driverProfile=null;if(r.driverId)driverProfile=mongoReady?await Driver.findOne({userId:r.driverId}).lean():memory.drivers.find(d=>idOf(d.userId)===idOf(r.driverId));res.json({ride:r,client:publicUser(client),driver:driverUser?{user:publicUser(driverUser),profile:driverProfile}:null});});
app.get('/api/rides/available',auth,role('driver'),ensureActive,async(req,res)=>{const d=mongoReady?await Driver.findOne({userId:req.user._id}).lean():memory.drivers.find(x=>idOf(x.userId)===idOf(req.user));if(!d?.approved)return res.json([]);let rides=mongoReady?await Ride.find({status:'pending',driverId:null}).sort({createdAt:-1}).limit(80).lean():memory.rides.filter(r=>r.status==='pending'&&!r.driverId).slice(0,80);const now=Date.now();rides=rides.filter(r=>!r.scheduledFor||new Date(r.scheduledFor).getTime()<=now+30*60*1000).map(r=>({...r,distanceToPickupKm:d.location?Number(haversineKm(d.location,r.pickup).toFixed(1)):null})).sort((a,b)=>(a.distanceToPickupKm??999)-(b.distanceToPickupKm??999));res.json(rides);});
app.post('/api/rides/:id/accept',auth,role('driver'),ensureActive,async(req,res)=>{const d=mongoReady?await Driver.findOne({userId:req.user._id}):memory.drivers.find(x=>idOf(x.userId)===idOf(req.user));if(!d?.approved||!d?.online)return res.status(403).json({error:'Avval admin tasdig‘i va Onlayn holat talab qilinadi'});let ride;if(mongoReady)ride=await Ride.findOneAndUpdate({_id:req.params.id,status:'pending',driverId:null},{driverId:req.user._id,status:'accepted',acceptedAt:new Date()},{new:true}).lean();else{ride=memory.rides.find(r=>idOf(r)===req.params.id&&r.status==='pending'&&!r.driverId);if(ride)Object.assign(ride,{driverId:idOf(req.user),status:'accepted',acceptedAt:nowIso()});}if(!ride)return res.status(409).json({error:'Buyurtmani boshqa haydovchi olgan yoki u yopilgan'});await notify(idOf(ride.clientId),'Haydovchi topildi','Haydovchi buyurtmangizni qabul qildi.','ride');io.to(`user:${idOf(ride.clientId)}`).emit('ride:updated',ride);io.to('role:driver').emit('ride:taken',{rideId:idOf(ride)});io.to('role:admin').emit('admin:refresh');res.json(ride);});
app.patch('/api/rides/:id/status',auth,role('driver','admin'),ensureActive,async(req,res)=>{const next=req.body.status,allowed=['arrived','in_progress','completed','cancelled'];if(!allowed.includes(next))return res.status(400).json({error:'Status noto‘g‘ri'});let ride=mongoReady?await Ride.findById(req.params.id):memory.rides.find(r=>idOf(r)===req.params.id);if(!ride)return res.status(404).json({error:'Buyurtma topilmadi'});if(req.user.role==='driver'&&idOf(ride.driverId)!==idOf(req.user))return res.status(403).json({error:'Bu buyurtma sizniki emas'});const transitions={accepted:['arrived','cancelled'],arrived:['in_progress','cancelled'],in_progress:['completed','cancelled'],pending:['cancelled']};if(req.user.role!=='admin'&&!(transitions[ride.status]||[]).includes(next))return res.status(409).json({error:`${ride.status} → ${next} o‘tish mumkin emas`});ride.status=next;if(next==='arrived')ride.arrivedAt=new Date();if(next==='in_progress')ride.startedAt=new Date();if(next==='completed'){ride.completedAt=new Date();if(ride.paymentMethod==='cash')ride.paymentStatus='paid';}if(next==='cancelled')ride.cancelledAt=new Date();if(mongoReady)await ride.save();if(next==='completed'&&ride.driverId){const s=await getSettings(),earning=Math.round(Number(ride.fare||0)*(1-Number(s.commissionPercent||0)/100));if(mongoReady){await Driver.updateOne({userId:ride.driverId},{$inc:{completedRides:1,totalEarnings:earning}});await Transaction.create({userId:ride.driverId,rideId:ride._id,type:'earning',amount:earning,description:'Safar daromadi'});}else{const dp=memory.drivers.find(x=>idOf(x.userId)===idOf(ride.driverId));if(dp){dp.completedRides=(dp.completedRides||0)+1;dp.totalEarnings=(dp.totalEarnings||0)+earning;}}}const out=mongoReady?ride.toObject():ride;await notify(idOf(ride.clientId),next==='arrived'?'Haydovchi yetib keldi':next==='in_progress'?'Safar boshlandi':next==='completed'?'Safar yakunlandi':'Safar yangilandi',next==='completed'?`${Number(ride.fare||0).toLocaleString('uz-UZ')} so‘m`:`Status: ${next}`,'ride');io.to(`user:${idOf(ride.clientId)}`).emit('ride:updated',out);if(ride.driverId)io.to(`user:${idOf(ride.driverId)}`).emit('ride:updated',out);io.to('role:admin').emit('admin:refresh');res.json(out);});
app.post('/api/rides/:id/cancel',auth,ensureActive,async(req,res)=>{let ride=mongoReady?await Ride.findById(req.params.id):memory.rides.find(r=>idOf(r)===req.params.id);if(!ride)return res.status(404).json({error:'Buyurtma topilmadi'});const uid=idOf(req.user);if(req.user.role!=='admin'&&uid!==idOf(ride.clientId)&&uid!==idOf(ride.driverId))return res.status(403).json({error:'Ruxsat yo‘q'});if(['completed','cancelled'].includes(ride.status))return res.status(409).json({error:'Bu buyurtma yopilgan'});ride.status='cancelled';ride.cancelReason=safeText(req.body.reason,180)||'Bekor qilindi';ride.cancelledAt=new Date();if(mongoReady)await ride.save();const out=mongoReady?ride.toObject():ride;io.to(`user:${idOf(ride.clientId)}`).emit('ride:updated',out);if(ride.driverId)io.to(`user:${idOf(ride.driverId)}`).emit('ride:updated',out);io.to('role:admin').emit('admin:refresh');res.json(out);});
app.post('/api/rides/:id/rate',auth,role('client'),ensureActive,async(req,res)=>{const rating=clamp(req.body.rating,1,5);let ride=mongoReady?await Ride.findOne({_id:req.params.id,clientId:req.user._id,status:'completed'}):memory.rides.find(r=>idOf(r)===req.params.id&&idOf(r.clientId)===idOf(req.user)&&r.status==='completed');if(!ride)return res.status(404).json({error:'Baholash uchun yakunlangan buyurtma topilmadi'});ride.rating=rating;ride.feedback=safeText(req.body.feedback,280);if(mongoReady)await ride.save();if(ride.driverId){if(mongoReady){const vals=await Ride.find({driverId:ride.driverId,status:'completed',rating:{$gte:1}}).select('rating').lean();const avg=vals.reduce((a,x)=>a+Number(x.rating||0),0)/Math.max(1,vals.length);await Driver.updateOne({userId:ride.driverId},{rating:Number(avg.toFixed(2))});}else{const vals=memory.rides.filter(r=>idOf(r.driverId)===idOf(ride.driverId)&&r.status==='completed'&&r.rating).map(r=>Number(r.rating));const dp=memory.drivers.find(d=>idOf(d.userId)===idOf(ride.driverId));if(dp)dp.rating=vals.reduce((a,b)=>a+b,0)/Math.max(1,vals.length);}}res.json({ok:true,rating});});
app.post('/api/rides/:id/sos',auth,ensureActive,async(req,res)=>{let ride=mongoReady?await Ride.findById(req.params.id):memory.rides.find(r=>idOf(r)===req.params.id);if(!ride)return res.status(404).json({error:'Buyurtma topilmadi'});const uid=idOf(req.user);if(uid!==idOf(ride.clientId)&&uid!==idOf(ride.driverId))return res.status(403).json({error:'Ruxsat yo‘q'});ride.sos=true;if(mongoReady)await ride.save();io.to('role:admin').emit('sos',{rideId:idOf(ride),by:uid,time:nowIso(),pickup:ride.pickup,destination:ride.destination});res.json({ok:true});});

app.get('/api/notifications',auth,ensureActive,async(req,res)=>{const rows=mongoReady?await Notification.find({userId:req.user._id}).sort({createdAt:-1}).limit(50).lean():memory.notifications.filter(n=>idOf(n.userId)===idOf(req.user)).slice(0,50);res.json(rows);});
app.patch('/api/notifications/read',auth,ensureActive,async(req,res)=>{if(mongoReady)await Notification.updateMany({userId:req.user._id,read:false},{$set:{read:true}});else memory.notifications.filter(n=>idOf(n.userId)===idOf(req.user)).forEach(n=>n.read=true);res.json({ok:true});});
app.get('/api/support',auth,ensureActive,async(req,res)=>{const q=req.user.role==='admin'?{}:{userId:mongoReady?req.user._id:idOf(req.user)};const rows=mongoReady?await Ticket.find(q).sort({createdAt:-1}).limit(100).lean():memory.tickets.filter(t=>req.user.role==='admin'||idOf(t.userId)===idOf(req.user)).slice(0,100);res.json(rows);});
app.post('/api/support',auth,ensureActive,async(req,res)=>{const data={userId:mongoReady?req.user._id:idOf(req.user),subject:safeText(req.body.subject,100),message:safeText(req.body.message,1200),priority:['low','normal','high'].includes(req.body.priority)?req.body.priority:'normal',status:'open',adminReply:'',createdAt:nowIso()};if(data.subject.length<2||data.message.length<5)return res.status(400).json({error:'Mavzu va xabarni kiriting'});let t;if(mongoReady)t=await Ticket.create(data);else{t={id:crypto.randomUUID(),...data};memory.tickets.unshift(t);}io.to('role:admin').emit('support:new',t);res.status(201).json(t);});

app.get('/api/admin/stats',auth,role('admin'),ensureActive,async(_req,res)=>{if(mongoReady){const [users,clients,drivers,pendingDrivers,onlineDrivers,rides,active,completed,cancelled,revenueAgg,sos]=await Promise.all([User.countDocuments(),User.countDocuments({role:'client'}),User.countDocuments({role:'driver'}),Driver.countDocuments({approved:false}),Driver.countDocuments({online:true,approved:true}),Ride.countDocuments(),Ride.countDocuments({status:{$in:['pending','accepted','arrived','in_progress']}}),Ride.countDocuments({status:'completed'}),Ride.countDocuments({status:'cancelled'}),Ride.aggregate([{$match:{status:'completed'}},{$group:{_id:null,total:{$sum:'$fare'}}}]),Ride.countDocuments({sos:true,status:{$in:['accepted','arrived','in_progress']}})]);return res.json({users,clients,drivers,pendingDrivers,onlineDrivers,rides,active,completed,cancelled,revenue:revenueAgg[0]?.total||0,sos});}res.json({users:memory.users.length,clients:memory.users.filter(u=>u.role==='client').length,drivers:memory.users.filter(u=>u.role==='driver').length,pendingDrivers:memory.drivers.filter(d=>!d.approved).length,onlineDrivers:memory.drivers.filter(d=>d.online&&d.approved).length,rides:memory.rides.length,active:memory.rides.filter(r=>['pending','accepted','arrived','in_progress'].includes(r.status)).length,completed:memory.rides.filter(r=>r.status==='completed').length,cancelled:memory.rides.filter(r=>r.status==='cancelled').length,revenue:memory.rides.filter(r=>r.status==='completed').reduce((a,r)=>a+Number(r.fare||0),0),sos:memory.rides.filter(r=>r.sos&&['accepted','arrived','in_progress'].includes(r.status)).length});});
app.get('/api/admin/users',auth,role('admin'),ensureActive,async(_req,res)=>res.json(mongoReady?await User.find().sort({createdAt:-1}).select('-passwordHash').lean():memory.users.map(publicUser)));
app.patch('/api/admin/users/:id/status',auth,role('admin'),ensureActive,async(req,res)=>{const status=req.body.status==='blocked'?'blocked':'active';let u=mongoReady?await User.findByIdAndUpdate(req.params.id,{status},{new:true}).select('-passwordHash').lean():memory.users.find(x=>idOf(x)===req.params.id);if(!mongoReady&&u)u.status=status;if(!u)return res.status(404).json({error:'Foydalanuvchi topilmadi'});io.to(`user:${req.params.id}`).emit('account:status',{status});res.json(publicUser(u));});
app.get('/api/admin/drivers',auth,role('admin'),ensureActive,async(_req,res)=>{if(mongoReady){const ds=await Driver.find().sort({createdAt:-1}).lean(),ids=ds.map(d=>d.userId),us=await User.find({_id:{$in:ids}}).select('name phone status avatar').lean(),m=new Map(us.map(u=>[idOf(u),u]));return res.json(ds.map(d=>({...d,user:publicUser(m.get(idOf(d.userId)))})));}res.json(memory.drivers.map(d=>({...d,user:publicUser(memory.users.find(u=>idOf(u)===idOf(d.userId)))})));});
app.patch('/api/admin/drivers/:id/approve',auth,role('admin'),ensureActive,async(req,res)=>{const approved=!!req.body.approved,note=safeText(req.body.note,180);let d=mongoReady?await Driver.findOneAndUpdate({userId:req.params.id},{approved,documentStatus:approved?'approved':'rejected',documentNote:note,...(approved?{}:{online:false})},{new:true}).lean():memory.drivers.find(x=>idOf(x.userId)===req.params.id);if(!mongoReady&&d){d.approved=approved;d.documentStatus=approved?'approved':'rejected';d.documentNote=note;if(!approved)d.online=false;}if(!d)return res.status(404).json({error:'Haydovchi topilmadi'});io.to(`user:${req.params.id}`).emit('driver:approval',{approved,note});res.json(d);});
app.get('/api/admin/rides',auth,role('admin'),ensureActive,async(req,res)=>{const status=safeText(req.query.status,30);const q=status?{status}:{};res.json(mongoReady?await Ride.find(q).sort({createdAt:-1}).limit(400).lean():memory.rides.filter(r=>!status||r.status===status).slice(0,400));});
app.get('/api/admin/live',auth,role('admin'),ensureActive,async(_req,res)=>{const drivers=mongoReady?await Driver.find({online:true,approved:true}).lean():memory.drivers.filter(d=>d.online&&d.approved);const ids=drivers.map(d=>d.userId),users=mongoReady?await User.find({_id:{$in:ids}}).select('name phone').lean():memory.users.filter(u=>ids.some(id=>idOf(id)===idOf(u)));const um=new Map(users.map(u=>[idOf(u),publicUser(u)]));const rides=mongoReady?await Ride.find({status:{$in:['pending','accepted','arrived','in_progress']}}).lean():memory.rides.filter(r=>['pending','accepted','arrived','in_progress'].includes(r.status));res.json({drivers:drivers.map(d=>({...d,user:um.get(idOf(d.userId))||null})),rides});});
app.put('/api/admin/pricing',auth,role('admin'),ensureActive,async(req,res)=>{const patch={baseFare:clamp(req.body.baseFare,0,1e7),perKm:clamp(req.body.perKm,0,1e7),perMinute:clamp(req.body.perMinute,0,1e6),minimumFare:clamp(req.body.minimumFare,0,1e7),serviceFee:clamp(req.body.serviceFee,0,1e7),economyMultiplier:clamp(req.body.economyMultiplier,.5,5),comfortMultiplier:clamp(req.body.comfortMultiplier,.5,5),businessMultiplier:clamp(req.body.businessMultiplier,.5,5),surgeMultiplier:clamp(req.body.surgeMultiplier,1,5),commissionPercent:clamp(req.body.commissionPercent,0,50),cancellationFee:clamp(req.body.cancellationFee,0,1e6),city:safeText(req.body.city,80)||'Qarshi'};if(mongoReady)await Settings.findOneAndUpdate({key:'pricing'},patch,{new:true,upsert:true});else Object.assign(memory.settings,patch);const s=await getSettings();io.emit('pricing:updated',s);res.json(s);});
app.get('/api/admin/promos',auth,role('admin'),ensureActive,async(_req,res)=>res.json(mongoReady?await Promo.find().sort({createdAt:-1}).lean():memory.promos));
app.post('/api/admin/promos',auth,role('admin'),ensureActive,async(req,res)=>{const data={code:safeText(req.body.code,32).toUpperCase(),type:req.body.type==='fixed'?'fixed':'percent',value:clamp(req.body.value,0,1e7),maxDiscount:clamp(req.body.maxDiscount,0,1e7),active:req.body.active!==false,usageLimit:clamp(req.body.usageLimit,0,1e7),usedCount:0,expiresAt:req.body.expiresAt?new Date(req.body.expiresAt):null};if(data.code.length<3)return res.status(400).json({error:'Promo kod kamida 3 belgi'});try{let p;if(mongoReady)p=await Promo.create(data);else{if(memory.promos.some(x=>x.code===data.code))return res.status(409).json({error:'Promo kod mavjud'});p={id:crypto.randomUUID(),...data,createdAt:nowIso()};memory.promos.unshift(p);}res.status(201).json(p);}catch(e){res.status(409).json({error:'Promo kod mavjud yoki xato',detail:e.message});}});
app.patch('/api/admin/promos/:id',auth,role('admin'),ensureActive,async(req,res)=>{const active=!!req.body.active;let p=mongoReady?await Promo.findByIdAndUpdate(req.params.id,{active},{new:true}).lean():memory.promos.find(x=>idOf(x)===req.params.id);if(!mongoReady&&p)p.active=active;if(!p)return res.status(404).json({error:'Promo topilmadi'});res.json(p);});
app.patch('/api/admin/support/:id',auth,role('admin'),ensureActive,async(req,res)=>{const patch={status:['open','in_progress','closed'].includes(req.body.status)?req.body.status:'open',adminReply:safeText(req.body.adminReply,1200)};let t=mongoReady?await Ticket.findByIdAndUpdate(req.params.id,patch,{new:true}).lean():memory.tickets.find(x=>idOf(x)===req.params.id);if(!mongoReady&&t)Object.assign(t,patch);if(!t)return res.status(404).json({error:'Murojaat topilmadi'});await notify(idOf(t.userId),'Yordam markazi javobi',patch.adminReply||`Status: ${patch.status}`,'support');res.json(t);});

app.get('/api/geocode/search',async(req,res)=>{const q=safeText(req.query.q,140);if(q.length<3)return res.json([]);try{const url=new URL('https://nominatim.openstreetmap.org/search');url.searchParams.set('format','jsonv2');url.searchParams.set('limit','7');url.searchParams.set('addressdetails','1');url.searchParams.set('countrycodes','uz');url.searchParams.set('q',q);const r=await fetch(url,{headers:{'User-Agent':NOMINATIM_USER_AGENT,'Accept-Language':'uz,ru;q=0.8,en;q=0.6'}});if(!r.ok)throw new Error();const data=await r.json();res.json((Array.isArray(data)?data:[]).map(x=>({label:x.display_name,lat:Number(x.lat),lng:Number(x.lon)})));}catch{res.json([]);}});
app.get('/api/geocode/reverse',async(req,res)=>{const lat=Number(req.query.lat),lng=Number(req.query.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({error:'Koordinata xato'});try{const url=new URL('https://nominatim.openstreetmap.org/reverse');url.searchParams.set('format','jsonv2');url.searchParams.set('lat',lat);url.searchParams.set('lon',lng);url.searchParams.set('zoom','18');const r=await fetch(url,{headers:{'User-Agent':NOMINATIM_USER_AGENT,'Accept-Language':'uz,ru;q=0.8,en;q=0.6'}});if(!r.ok)throw new Error();const x=await r.json();res.json({label:x.display_name||`${lat.toFixed(5)}, ${lng.toFixed(5)}`,lat,lng});}catch{res.json({label:`${lat.toFixed(5)}, ${lng.toFixed(5)}`,lat,lng});}});

io.use((socket,next)=>{try{socket.auth=jwt.verify(socket.handshake.auth?.token,JWT_SECRET);next();}catch{next(new Error('unauthorized'));}});
io.on('connection',async socket=>{const u=await findUserById(socket.auth.sub);if(!u||u.status!=='active')return socket.disconnect(true);socket.join(`user:${idOf(u)}`);socket.join(`role:${u.role}`);socket.emit('connected',{ok:true,userId:idOf(u)});});

app.use(express.static(path.join(__dirname,'public'),{maxAge:process.env.NODE_ENV==='production'?'30m':0}));
app.get('*',(req,res,next)=>{if(req.path.startsWith('/api/'))return next();res.sendFile(path.join(__dirname,'public','index.html'));});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Server xatosi'});});

connectDatabase().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log(`[${APP_NAME}] v2 listening on :${PORT}`)));
