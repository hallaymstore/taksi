'use strict';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const JWT_SECRET = process.env.JWT_SECRET || '';
const OFFER_SECONDS = Math.max(10, Math.min(45, Number(process.env.DISPATCH_OFFER_SECONDS || 20)));
const SEARCH_RADII = [3, 5, 8, 15];
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const PAYMENT_RECEIVER_CARD = String(process.env.PAYMENT_RECEIVER_CARD || '').replace(/\s+/g, ' ').trim();
const PAYMENT_RECEIVER_NAME = String(process.env.PAYMENT_RECEIVER_NAME || '').trim();
const PAYMENT_NOTE = String(process.env.PAYMENT_NOTE || "To‘lovdan keyin chek/skrinshotni yuklang.").trim();
const CLICK_READY = Boolean(process.env.CLICK_MERCHANT_ID && process.env.CLICK_SERVICE_ID && process.env.CLICK_SECRET_KEY);
const PAYME_READY = Boolean(process.env.PAYME_MERCHANT_ID && process.env.PAYME_SECRET_KEY);

function idOf(v) { return String(v?._id || v?.id || v || ''); }
function safe(v, n = 180) { return String(v ?? '').trim().slice(0, n); }
function normalizePhone(v = '') {
  const d = String(v).replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 9) return `+998${d}`;
  if (d.startsWith('998')) return `+${d}`;
  return `+${d}`;
}
function km(a, b) {
  if (!a || !b) return Infinity;
  const vals = [a.lat, a.lng, b.lat, b.lng].map(Number);
  if (!vals.every(Number.isFinite)) return Infinity;
  const [alat, alng, blat, blng] = vals, R = 6371;
  const dLat = (blat-alat)*Math.PI/180, dLng=(blng-alng)*Math.PI/180;
  const x = Math.sin(dLat/2)**2 + Math.cos(alat*Math.PI/180)*Math.cos(blat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function classLevel(v) { return v === 'business' ? 2 : v === 'comfort' ? 1 : 0; }
function maskedCard(v) { const d=String(v||'').replace(/\D/g,''); return d.length >= 4 ? `•••• •••• •••• ${d.slice(-4)}` : ''; }

module.exports = function attachDispatcher(app, { io } = {}) {
  if (!app) throw new Error('Express app required');
  const User = mongoose.model('User');
  const Driver = mongoose.model('Driver');
  const Ride = mongoose.model('Ride');
  const Settings = mongoose.model('Settings');
  const Promo = mongoose.model('Promo');
  const Notification = mongoose.model('Notification');
  const Transaction = mongoose.model('Transaction');

  Driver.schema.add({
    availabilityStatus: { type:String, enum:['offline','available','offered','busy','paused'], default:'offline', index:true },
    currentRideId: { type:mongoose.Schema.Types.ObjectId, ref:'Ride', default:null },
    currentOfferRideId: { type:mongoose.Schema.Types.ObjectId, ref:'Ride', default:null },
    offerExpiresAt: Date,
    lastLocationAt: Date,
    heading: Number,
    speedKmh: Number,
    acceptRadiusKm: { type:Number, default:8 },
    autoAccept: { type:Boolean, default:false },
    offersCount: { type:Number, default:0 },
    acceptedCount: { type:Number, default:0 },
    skippedCount: { type:Number, default:0 }
  });
  Ride.schema.add({
    dispatchStatus: { type:String, enum:['searching','offered','pool','accepted','closed','cancelled'], default:'searching', index:true },
    currentOfferDriverId: { type:mongoose.Schema.Types.ObjectId, ref:'User', default:null },
    offerExpiresAt: Date,
    offeredDriverIds: [{ type:mongoose.Schema.Types.ObjectId, ref:'User' }],
    dispatchRound: { type:Number, default:0 },
    searchRadiusKm: { type:Number, default:3 },
    acceptedDriverDistanceKm: Number,
    paymentFlow: { type:String, enum:['cash','manual_card','gateway','wallet'], default:'cash' },
    paymentProvider: String,
    paymentProofUrl: String,
    cashCollected: { type:Boolean, default:false },
    paymentConfirmedAt: Date,
    paymentReference: String,
    refundStatus: { type:String, enum:['none','refunded'], default:'none' }
  });
  const pm = Ride.schema.path('paymentMethod');
  if (pm && !pm.enumValues.includes('card')) pm.enum('card');

  async function auth(req,res,next) {
    try {
      const raw=req.headers.authorization||'', token=raw.startsWith('Bearer ')?raw.slice(7):'';
      if(!token||!JWT_SECRET)return res.status(401).json({error:'Avtorizatsiya talab qilinadi'});
      const p=jwt.verify(token,JWT_SECRET), u=await User.findById(p.sub);
      if(!u||u.status!=='active')return res.status(403).json({error:'Akkaunt faol emas'});
      req.dispatchUser=u; next();
    } catch { return res.status(401).json({error:'Sessiya yaroqsiz'}); }
  }
  const only=(...roles)=>(req,res,next)=>roles.includes(req.dispatchUser?.role)?next():res.status(403).json({error:'Ruxsat yetarli emas'});
  async function notify(uid,title,body,type='ride') {
    if(!uid)return;
    try {
      const n=await Notification.create({userId:uid,title,body,type});
      io?.to(`user:${idOf(uid)}`).emit('notification:new',n.toObject());
    } catch {}
  }
  async function settings() { return (await Settings.findOne({key:'pricing'}).lean()) || {baseFare:5000,perKm:2500,perMinute:250,minimumFare:7000,serviceFee:0,economyMultiplier:1,comfortMultiplier:1.35,businessMultiplier:1.8,surgeMultiplier:1}; }
  async function routeInfo(a,b) {
    try {
      const u=`${OSRM_URL.replace(/\/$/,'')}/route/v1/driving/${Number(a.lng)},${Number(a.lat)};${Number(b.lng)},${Number(b.lat)}?overview=full&geometries=geojson&steps=false`;
      const r=await fetch(u,{headers:{'User-Agent':'HALLAYM-Taxi-Dispatcher/4'}}); if(!r.ok)throw new Error('route');
      const j=await r.json(), x=j.routes?.[0]; if(!x)throw new Error('route');
      return {distanceKm:Number((x.distance/1000).toFixed(2)),durationMin:Math.max(1,Math.round(x.duration/60)),geometry:x.geometry};
    } catch {
      const d=Math.max(.3,km(a,b)*1.18); return {distanceKm:Number(d.toFixed(2)),durationMin:Math.max(2,Math.round(d/28*60)),geometry:{type:'LineString',coordinates:[[Number(a.lng),Number(a.lat)],[Number(b.lng),Number(b.lat)]]},fallback:true};
    }
  }
  function fare(route,klass,s) {
    const m=klass==='business'?Number(s.businessMultiplier||1.8):klass==='comfort'?Number(s.comfortMultiplier||1.35):Number(s.economyMultiplier||1);
    return Math.ceil(Math.max(Number(s.minimumFare||7000),(Number(s.baseFare||5000)+route.distanceKm*Number(s.perKm||2500)+route.durationMin*Number(s.perMinute||0)+Number(s.serviceFee||0))*m*Number(s.surgeMultiplier||1))/500)*500;
  }
  async function promo(code, amount) {
    const c=safe(code,32).toUpperCase(); if(!c)return {row:null,discount:0};
    const p=await Promo.findOne({code:c}).lean();
    if(!p||!p.active||(p.expiresAt&&new Date(p.expiresAt)<new Date())||(Number(p.usageLimit||0)>0&&Number(p.usedCount||0)>=Number(p.usageLimit)))return {row:null,discount:0};
    let d=p.type==='fixed'?Number(p.value||0):amount*Number(p.value||0)/100;
    if(Number(p.maxDiscount||0)>0)d=Math.min(d,Number(p.maxDiscount));
    return {row:p,discount:Math.max(0,Math.min(amount,d))};
  }
  async function activeRideForDriver(uid) { return Ride.findOne({driverId:uid,status:{$in:['accepted','arrived','in_progress']}}).lean(); }
  async function releaseDriver(uid, rideId=null) {
    const d=await Driver.findOne({userId:uid}); if(!d)return;
    if(rideId && d.currentRideId && idOf(d.currentRideId)!==idOf(rideId) && d.currentOfferRideId && idOf(d.currentOfferRideId)!==idOf(rideId))return;
    d.currentRideId=null; d.currentOfferRideId=null; d.offerExpiresAt=null;
    d.availabilityStatus=d.online?'available':'offline'; await d.save();
    io?.to(`user:${idOf(uid)}`).emit('driver:availability',{status:d.availabilityStatus});
  }
  async function acceptInternal(rideId, uid, distanceKm=null) {
    const ride=await Ride.findOneAndUpdate({_id:rideId,status:'pending',driverId:null,$or:[{currentOfferDriverId:uid},{dispatchStatus:'pool'}]},{$set:{driverId:uid,status:'accepted',dispatchStatus:'accepted',acceptedAt:new Date(),acceptedDriverDistanceKm:distanceKm,currentOfferDriverId:null,offerExpiresAt:null}},{new:true});
    if(!ride)return null;
    await Driver.updateOne({userId:uid},{$set:{availabilityStatus:'busy',currentRideId:ride._id,currentOfferRideId:null,offerExpiresAt:null},$inc:{acceptedCount:1}});
    io?.to(`user:${idOf(ride.clientId)}`).emit('ride:updated',ride.toObject());
    io?.to(`user:${idOf(ride.clientId)}`).emit('dispatch:update',{rideId:idOf(ride),status:'accepted',driverId:idOf(uid)});
    io?.to('role:admin').emit('admin:refresh'); io?.to('role:driver').emit('ride:taken',{rideId:idOf(ride)});
    await notify(ride.clientId,'Haydovchi topildi','Haydovchi buyurtmangizni qabul qildi.');
    return ride;
  }
  async function dispatchNext(rideId) {
    const ride=await Ride.findById(rideId); if(!ride||ride.status!=='pending'||ride.driverId)return;
    if(ride.currentOfferDriverId && ride.offerExpiresAt && new Date(ride.offerExpiresAt)>new Date())return;
    if(ride.currentOfferDriverId)await releaseDriver(ride.currentOfferDriverId,ride._id);

    const activeDriverIds=(await Ride.distinct('driverId',{status:{$in:['accepted','arrived','in_progress']},driverId:{$ne:null}})).map(String);
    const offered=new Set((ride.offeredDriverIds||[]).map(String));
    let radius=Number(ride.searchRadiusKm||3), candidates=[];
    const all=await Driver.find({approved:true,online:true,'location.lat':{$type:'number'},'location.lng':{$type:'number'},availabilityStatus:{$in:['available','offline',null]}}).lean();
    for(const r of SEARCH_RADII.filter(x=>x>=radius)) {
      candidates=all.filter(d=>!activeDriverIds.includes(idOf(d.userId))&&!offered.has(idOf(d.userId))&&classLevel(d.vehicleClass)>=classLevel(ride.vehicleClass)&&km(ride.pickup,d.location)<=Math.min(r,Number(d.acceptRadiusKm||8))).map(d=>({...d,_distance:km(ride.pickup,d.location),_score:km(ride.pickup,d.location)*10+(5-Number(d.rating||5))*2+Number(d.offersCount||0)*.03})).sort((a,b)=>a._score-b._score);
      radius=r; if(candidates.length)break;
    }
    ride.searchRadiusKm=radius;
    if(!candidates.length) {
      ride.dispatchStatus='pool'; ride.currentOfferDriverId=null; ride.offerExpiresAt=null; await ride.save();
      io?.to('role:driver').emit('ride:pool',{rideId:idOf(ride),vehicleClass:ride.vehicleClass});
      io?.to(`user:${idOf(ride.clientId)}`).emit('dispatch:update',{rideId:idOf(ride),status:'pool',radiusKm:radius,message:'Bo‘sh haydovchilar qidirilmoqda'});
      return;
    }
    const d=candidates[0], expires=new Date(Date.now()+OFFER_SECONDS*1000);
    ride.dispatchStatus='offered'; ride.currentOfferDriverId=d.userId; ride.offerExpiresAt=expires; ride.dispatchRound=Number(ride.dispatchRound||0)+1;
    ride.offeredDriverIds=[...(ride.offeredDriverIds||[]),d.userId]; await ride.save();
    await Driver.updateOne({userId:d.userId},{$set:{availabilityStatus:'offered',currentOfferRideId:ride._id,offerExpiresAt:expires},$inc:{offersCount:1}});
    io?.to(`user:${idOf(d.userId)}`).emit('ride:offer',{...ride.toObject(),offerExpiresAt:expires,distanceToPickupKm:Number(d._distance.toFixed(1)),offerSeconds:OFFER_SECONDS});
    io?.to(`user:${idOf(ride.clientId)}`).emit('dispatch:update',{rideId:idOf(ride),status:'offered',radiusKm:radius,round:ride.dispatchRound,offerExpiresAt:expires});
    if(d.autoAccept) { await acceptInternal(ride._id,d.userId,d._distance); return; }
    setTimeout(()=>expireOffer(ride._id,d.userId).catch(()=>{}),OFFER_SECONDS*1000+700);
  }
  async function expireOffer(rideId,uid) {
    const r=await Ride.findById(rideId); if(!r||r.status!=='pending'||idOf(r.currentOfferDriverId)!==idOf(uid))return;
    if(r.offerExpiresAt&&new Date(r.offerExpiresAt)>new Date())return;
    await Driver.updateOne({userId:uid,currentOfferRideId:r._id},{$set:{availabilityStatus:'available',currentOfferRideId:null,offerExpiresAt:null},$inc:{skippedCount:1}});
    r.currentOfferDriverId=null;r.offerExpiresAt=null;r.dispatchStatus='searching';await r.save();
    io?.to(`user:${idOf(uid)}`).emit('ride:offer-expired',{rideId:idOf(r)}); await dispatchNext(r._id);
  }

  app.get('/api/payments/options',auth,async(req,res)=>{
    res.json({cash:{available:true,label:'Naqd'},manualCard:{available:Boolean(PAYMENT_RECEIVER_CARD),label:'Karta o‘tkazma',card:PAYMENT_RECEIVER_CARD,maskedCard:maskedCard(PAYMENT_RECEIVER_CARD),holder:PAYMENT_RECEIVER_NAME,note:PAYMENT_NOTE},wallet:{available:true,balance:Number(req.dispatchUser.walletBalance||0)},click:{available:CLICK_READY,autoPay:CLICK_READY},payme:{available:PAYME_READY,autoPay:PAYME_READY},autoPayAvailable:CLICK_READY||PAYME_READY});
  });
  app.get('/api/dispatch/summary',auth,async(req,res)=>{
    const lat=Number(req.query.lat),lng=Number(req.query.lng),klass=safe(req.query.class,20)||'economy'; if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.json({available:0,offered:0,busy:0,nearby:0});
    const ds=await Driver.find({approved:true,online:true,'location.lat':{$type:'number'},'location.lng':{$type:'number'}}).lean();
    const near=ds.filter(d=>classLevel(d.vehicleClass)>=classLevel(klass)&&km({lat,lng},d.location)<=15);
    const count=s=>near.filter(d=>(d.availabilityStatus||'available')===s).length;
    res.json({nearby:near.length,available:count('available'),offered:count('offered'),busy:count('busy'),paused:count('paused'),nearestKm:near.length?Number(Math.min(...near.map(d=>km({lat,lng},d.location))).toFixed(1)):null,etaMin:near.length?Math.max(2,Math.round(Math.min(...near.map(d=>km({lat,lng},d.location)))/25*60)):null});
  });
  app.get('/api/drivers/nearby',auth,async(req,res)=>{
    const lat=Number(req.query.lat),lng=Number(req.query.lng),klass=safe(req.query.class,20)||'economy';if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.json({count:0,etaMin:null});
    const ds=await Driver.find({approved:true,online:true,availabilityStatus:'available','location.lat':{$type:'number'},'location.lng':{$type:'number'}}).lean();
    const x=ds.filter(d=>classLevel(d.vehicleClass)>=classLevel(klass)).map(d=>km({lat,lng},d.location)).filter(Number.isFinite).sort((a,b)=>a-b);
    res.json({count:x.filter(v=>v<=15).length,etaMin:x.length?Math.max(2,Math.round(x[0]/25*60)):null,nearestKm:x.length?Number(x[0].toFixed(1)):null});
  });
  app.patch('/api/driver/online',auth,only('driver'),async(req,res)=>{
    const d=await Driver.findOne({userId:req.dispatchUser._id});if(!d)return res.status(404).json({error:'Haydovchi profili topilmadi'});const online=!!req.body.online;if(online&&!d.approved)return res.status(403).json({error:'Admin tasdig‘i kerak'});
    if(!online&&d.currentOfferRideId){const rid=d.currentOfferRideId;await Driver.updateOne({_id:d._id},{$set:{online:false,availabilityStatus:'offline',currentOfferRideId:null,offerExpiresAt:null}});const r=await Ride.findById(rid);if(r&&r.status==='pending'&&idOf(r.currentOfferDriverId)===idOf(req.dispatchUser)){r.currentOfferDriverId=null;r.offerExpiresAt=null;r.dispatchStatus='searching';await r.save();setTimeout(()=>dispatchNext(r._id),0);}return res.json({online:false,status:'offline'});}
    const ar=online?await activeRideForDriver(req.dispatchUser._id):null;d.online=online;d.lastOnlineAt=new Date();d.availabilityStatus=!online?'offline':ar?'busy':'available';await d.save();io?.to('role:admin').emit('driver:presence',{userId:idOf(req.dispatchUser),online,status:d.availabilityStatus,location:d.location});res.json({online,status:d.availabilityStatus});
  });
  app.patch('/api/driver/location',auth,only('driver'),async(req,res)=>{
    const lat=Number(req.body.lat),lng=Number(req.body.lng),heading=Number(req.body.heading),speedKmh=Number(req.body.speedKmh);if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({error:'Koordinata xato'});
    const d=await Driver.findOneAndUpdate({userId:req.dispatchUser._id},{$set:{location:{lat,lng},lastLocationAt:new Date(),...(Number.isFinite(heading)?{heading}:{}),...(Number.isFinite(speedKmh)?{speedKmh}: {})}},{new:true});
    const active=await activeRideForDriver(req.dispatchUser._id);if(active)io?.to(`user:${idOf(active.clientId)}`).emit('driver:location',{rideId:idOf(active),lat,lng,heading:d?.heading,speedKmh:d?.speedKmh,at:new Date()});io?.to('role:admin').emit('driver:location',{userId:idOf(req.dispatchUser),lat,lng,heading:d?.heading,speedKmh:d?.speedKmh,at:new Date()});res.json({ok:true,status:d?.availabilityStatus||'available'});
  });
  app.get('/api/driver/availability',auth,only('driver'),async(req,res)=>{const d=await Driver.findOne({userId:req.dispatchUser._id}).lean();res.json({online:!!d?.online,status:d?.availabilityStatus||'offline',autoAccept:!!d?.autoAccept,acceptRadiusKm:Number(d?.acceptRadiusKm||8),offerExpiresAt:d?.offerExpiresAt||null,currentRideId:d?.currentRideId||null});});
  app.patch('/api/driver/preferences',auth,only('driver'),async(req,res)=>{const patch={};if('autoAccept'in req.body)patch.autoAccept=!!req.body.autoAccept;if('acceptRadiusKm'in req.body)patch.acceptRadiusKm=Math.max(2,Math.min(20,Number(req.body.acceptRadiusKm)||8));if(req.body.availabilityStatus==='paused')patch.availabilityStatus='paused';if(req.body.availabilityStatus==='available')patch.availabilityStatus='available';const d=await Driver.findOneAndUpdate({userId:req.dispatchUser._id},patch,{new:true}).lean();res.json({autoAccept:!!d?.autoAccept,acceptRadiusKm:d?.acceptRadiusKm||8,status:d?.availabilityStatus});});
  app.get('/api/rides/available',auth,only('driver'),async(req,res)=>{
    const d=await Driver.findOne({userId:req.dispatchUser._id}).lean();if(!d?.approved||!d?.online||d.availabilityStatus==='busy'||d.availabilityStatus==='paused')return res.json([]);
    const targeted=await Ride.find({status:'pending',currentOfferDriverId:req.dispatchUser._id,offerExpiresAt:{$gt:new Date()}}).sort({createdAt:-1}).lean();if(targeted.length)return res.json(targeted);
    const pool=await Ride.find({status:'pending',dispatchStatus:'pool',driverId:null}).sort({createdAt:1}).limit(30).lean();const out=pool.filter(r=>classLevel(d.vehicleClass)>=classLevel(r.vehicleClass)&&d.location&&km(r.pickup,d.location)<=Number(d.acceptRadiusKm||8)).slice(0,10);res.json(out);
  });
  app.post('/api/rides/:id/skip',auth,only('driver'),async(req,res)=>{const r=await Ride.findOne({_id:req.params.id,status:'pending',currentOfferDriverId:req.dispatchUser._id});if(!r)return res.status(409).json({error:'Bu taklif faol emas'});await Driver.updateOne({userId:req.dispatchUser._id},{$set:{availabilityStatus:'available',currentOfferRideId:null,offerExpiresAt:null},$inc:{skippedCount:1}});r.currentOfferDriverId=null;r.offerExpiresAt=null;r.dispatchStatus='searching';await r.save();io?.to(`user:${idOf(req.dispatchUser)}`).emit('ride:offer-skipped',{rideId:idOf(r)});setTimeout(()=>dispatchNext(r._id),0);res.json({ok:true});});
  app.post('/api/rides/:id/accept',auth,only('driver'),async(req,res)=>{const d=await Driver.findOne({userId:req.dispatchUser._id}).lean();if(!d?.approved||!d?.online||d.availabilityStatus==='busy')return res.status(403).json({error:'Haydovchi bo‘sh va onlayn bo‘lishi kerak'});if(await activeRideForDriver(req.dispatchUser._id))return res.status(409).json({error:'Sizda faol safar bor'});const r0=await Ride.findById(req.params.id).lean();const dist=d.location&&r0?km(r0.pickup,d.location):null;const r=await acceptInternal(req.params.id,req.dispatchUser._id,Number.isFinite(dist)?Number(dist.toFixed(1)):null);if(!r)return res.status(409).json({error:'Buyurtmani boshqa haydovchi qabul qilgan yoki taklif tugagan'});res.json(r);});

  app.post('/api/rides',auth,only('client'),async(req,res)=>{try{
    const p=req.body.pickup||{},q=req.body.destination||{},pickup={label:safe(p.label),lat:Number(p.lat),lng:Number(p.lng)},destination={label:safe(q.label),lat:Number(q.lat),lng:Number(q.lng)};if(![pickup.lat,pickup.lng,destination.lat,destination.lng].every(Number.isFinite))return res.status(400).json({error:'Jo‘nash va manzil nuqtalarini tanlang'});
    const existing=await Ride.findOne({clientId:req.dispatchUser._id,status:{$in:['pending','accepted','arrived','in_progress']}});if(existing)return res.status(409).json({error:'Sizda allaqachon faol buyurtma bor',rideId:idOf(existing)});
    const s=await settings(),route=await routeInfo(pickup,destination),vehicleClass=['economy','comfort','business'].includes(req.body.vehicleClass)?req.body.vehicleClass:'economy',originalFare=fare(route,vehicleClass,s),pr=await promo(req.body.promoCode,originalFare),amount=Math.max(0,originalFare-pr.discount);
    let paymentMethod=['cash','click','payme','wallet','card'].includes(req.body.paymentMethod)?req.body.paymentMethod:'cash';if(paymentMethod==='click'&&!CLICK_READY)return res.status(400).json({error:'Click avtoto‘lov uchun merchant API hali ulanmagan. Naqd yoki karta o‘tkazmani tanlang.'});if(paymentMethod==='payme'&&!PAYME_READY)return res.status(400).json({error:'Payme avtoto‘lov uchun merchant API hali ulanmagan. Naqd yoki karta o‘tkazmani tanlang.'});if(paymentMethod==='card'&&!PAYMENT_RECEIVER_CARD)return res.status(400).json({error:'Karta rekviziti sozlanmagan'});if(paymentMethod==='wallet'&&Number(req.dispatchUser.walletBalance||0)<amount)return res.status(400).json({error:'Hamyon balansida mablag‘ yetarli emas'});
    const flow=paymentMethod==='cash'?'cash':paymentMethod==='card'?'manual_card':paymentMethod==='wallet'?'wallet':'gateway',paymentStatus=paymentMethod==='wallet'?'paid':paymentMethod==='cash'?'unpaid':'pending',scheduled=req.body.scheduledFor?new Date(req.body.scheduledFor):null;if(scheduled&&Number.isNaN(scheduled.getTime()))return res.status(400).json({error:'Vaqt noto‘g‘ri'});
    const ride=await Ride.create({clientId:req.dispatchUser._id,driverId:null,pickup,destination,vehicleClass,paymentMethod,paymentFlow:flow,paymentProvider:['click','payme'].includes(paymentMethod)?paymentMethod:'',paymentStatus,distanceKm:route.distanceKm,durationMin:route.durationMin,fare:amount,originalFare,discount:pr.discount,promoCode:pr.row?.code||'',note:safe(req.body.note,240),passengerName:safe(req.body.passengerName,80),passengerPhone:normalizePhone(req.body.passengerPhone),scheduledFor:scheduled||null,status:'pending',dispatchStatus:'searching',searchRadiusKm:3,dispatchRound:0,offeredDriverIds:[],sos:false});
    if(paymentMethod==='wallet'){await User.updateOne({_id:req.dispatchUser._id},{$inc:{walletBalance:-amount}});await Transaction.create({userId:req.dispatchUser._id,rideId:ride._id,type:'ride',amount:-amount,description:'Taksi safari'});}if(pr.row)await Promo.updateOne({_id:pr.row._id},{$inc:{usedCount:1}});
    await notify(req.dispatchUser._id,'Buyurtma yaratildi','Eng yaqin bo‘sh haydovchilar qidirilmoqda.');io?.to('role:admin').emit('admin:refresh');res.status(201).json(ride);setTimeout(()=>dispatchNext(ride._id),20);
  }catch(e){console.error('[dispatch create]',e);res.status(500).json({error:'Buyurtma yaratishda xato'});}});

  app.get('/api/dispatch/ride/:id',auth,async(req,res)=>{const r=await Ride.findById(req.params.id).lean();if(!r)return res.status(404).json({error:'Safar topilmadi'});const uid=idOf(req.dispatchUser);if(req.dispatchUser.role!=='admin'&&uid!==idOf(r.clientId)&&uid!==idOf(r.driverId)&&uid!==idOf(r.currentOfferDriverId))return res.status(403).json({error:'Ruxsat yo‘q'});res.json({rideId:idOf(r),status:r.status,dispatchStatus:r.dispatchStatus||'searching',round:Number(r.dispatchRound||0),radiusKm:Number(r.searchRadiusKm||3),offerExpiresAt:r.offerExpiresAt||null,offeredCount:(r.offeredDriverIds||[]).length,driverId:r.driverId||null,paymentMethod:r.paymentMethod,paymentStatus:r.paymentStatus,paymentFlow:r.paymentFlow});});
  app.get('/api/rides/:id/tracker',auth,async(req,res)=>{const r=await Ride.findById(req.params.id).lean();if(!r)return res.status(404).json({error:'Safar topilmadi'});const uid=idOf(req.dispatchUser);if(req.dispatchUser.role!=='admin'&&uid!==idOf(r.clientId)&&uid!==idOf(r.driverId))return res.status(403).json({error:'Ruxsat yo‘q'});let d=null;if(r.driverId)d=await Driver.findOne({userId:r.driverId}).lean();const target=r.status==='in_progress'?r.destination:r.pickup,dist=d?.location?km(d.location,target):null;const last=d?.lastLocationAt?new Date(d.lastLocationAt):null;res.json({rideId:idOf(r),status:r.status,driverLocation:d?.location||null,heading:d?.heading||null,speedKmh:d?.speedKmh||null,lastLocationAt:last,stale:last?Date.now()-last.getTime()>30000:true,distanceToTargetKm:Number.isFinite(dist)?Number(dist.toFixed(2)):null,etaToTargetMin:Number.isFinite(dist)?Math.max(1,Math.round(dist/25*60)):null,availability:d?.availabilityStatus||null});});
  app.patch('/api/rides/:id/status',auth,only('driver','admin'),async(req,res)=>{const next=req.body.status,r=await Ride.findById(req.params.id);if(!r)return res.status(404).json({error:'Safar topilmadi'});if(req.dispatchUser.role==='driver'&&idOf(r.driverId)!==idOf(req.dispatchUser))return res.status(403).json({error:'Bu safar sizniki emas'});const transitions={accepted:['arrived','cancelled'],arrived:['in_progress','cancelled'],in_progress:['completed']};if(req.dispatchUser.role!=='admin'&&!(transitions[r.status]||[]).includes(next))return res.status(409).json({error:'Status ketma-ketligi noto‘g‘ri'});if(!['arrived','in_progress','completed','cancelled'].includes(next))return res.status(400).json({error:'Status noto‘g‘ri'});r.status=next;if(next==='arrived')r.arrivedAt=new Date();if(next==='in_progress')r.startedAt=new Date();if(next==='completed'){r.completedAt=new Date();r.dispatchStatus='closed';}if(next==='cancelled'){r.cancelledAt=new Date();r.dispatchStatus='cancelled';}await r.save();if(['completed','cancelled'].includes(next)&&r.driverId){if(next==='completed')await Driver.updateOne({userId:r.driverId},{$inc:{completedRides:1,totalEarnings:Number(r.fare||0)}});await releaseDriver(r.driverId,r._id);}io?.to(`user:${idOf(r.clientId)}`).emit('ride:updated',r.toObject());io?.to(`user:${idOf(r.driverId)}`).emit('ride:updated',r.toObject());io?.to('role:admin').emit('admin:refresh');res.json(r);});
  app.post('/api/rides/:id/cancel',auth,async(req,res)=>{const r=await Ride.findById(req.params.id);if(!r)return res.status(404).json({error:'Safar topilmadi'});const uid=idOf(req.dispatchUser);if(req.dispatchUser.role!=='admin'&&uid!==idOf(r.clientId)&&uid!==idOf(r.driverId))return res.status(403).json({error:'Ruxsat yo‘q'});if(['completed','cancelled'].includes(r.status))return res.status(409).json({error:'Safar yopilgan'});const offered=r.currentOfferDriverId,driver=r.driverId;r.status='cancelled';r.dispatchStatus='cancelled';r.cancelledAt=new Date();r.cancelReason=safe(req.body.reason,180);r.currentOfferDriverId=null;r.offerExpiresAt=null;if(r.paymentMethod==='wallet'&&r.paymentStatus==='paid'&&r.refundStatus!=='refunded'){await User.updateOne({_id:r.clientId},{$inc:{walletBalance:Number(r.fare||0)}});await Transaction.create({userId:r.clientId,rideId:r._id,type:'refund',amount:Number(r.fare||0),description:'Bekor qilingan taksi safari'});r.refundStatus='refunded';}await r.save();if(offered)await releaseDriver(offered,r._id);if(driver)await releaseDriver(driver,r._id);io?.to(`user:${idOf(r.clientId)}`).emit('ride:updated',r.toObject());if(driver)io?.to(`user:${idOf(driver)}`).emit('ride:updated',r.toObject());io?.to('role:admin').emit('admin:refresh');res.json(r);});
  app.post('/api/rides/:id/payment/cash-collected',auth,only('driver','admin'),async(req,res)=>{const r=await Ride.findById(req.params.id);if(!r)return res.status(404).json({error:'Safar topilmadi'});if(req.dispatchUser.role==='driver'&&idOf(r.driverId)!==idOf(req.dispatchUser))return res.status(403).json({error:'Bu safar sizniki emas'});if(r.paymentMethod!=='cash'||r.status!=='completed')return res.status(409).json({error:'Naqd to‘lov faqat yakunlangan naqd safar uchun'});r.cashCollected=true;r.paymentStatus='paid';r.paymentConfirmedAt=new Date();await r.save();await notify(r.clientId,'To‘lov yakunlandi','Haydovchi naqd to‘lovni qabul qilganini tasdiqladi.','payment');res.json({ok:true,paymentStatus:r.paymentStatus});});
  app.post('/api/rides/:id/payment/proof',auth,only('client'),async(req,res)=>{const r=await Ride.findOne({_id:req.params.id,clientId:req.dispatchUser._id});if(!r)return res.status(404).json({error:'Safar topilmadi'});if(r.paymentMethod!=='card')return res.status(409).json({error:'Bu safar karta o‘tkazma orqali emas'});r.paymentProofUrl=safe(req.body.url,700);r.paymentStatus='pending';await r.save();io?.to('role:admin').emit('payment:proof',{rideId:idOf(r),url:r.paymentProofUrl});res.json({ok:true,status:'pending'});});
  app.patch('/api/admin/rides/:id/payment',auth,only('admin'),async(req,res)=>{const st=req.body.status==='paid'?'paid':'failed',r=await Ride.findByIdAndUpdate(req.params.id,{$set:{paymentStatus:st,paymentConfirmedAt:st==='paid'?new Date():null,paymentReference:safe(req.body.reference,120)}},{new:true});if(!r)return res.status(404).json({error:'Safar topilmadi'});await notify(r.clientId,st==='paid'?'To‘lov tasdiqlandi':'To‘lov tasdiqlanmadi',st==='paid'?'Karta orqali to‘lov qabul qilindi.':'To‘lovni qayta tekshiring.','payment');res.json(r);});
  app.get('/api/admin/dispatch/live',auth,only('admin'),async(req,res)=>{const [drivers,rides]=await Promise.all([Driver.find({approved:true}).lean(),Ride.find({status:{$in:['pending','accepted','arrived','in_progress']}}).sort({createdAt:-1}).limit(100).lean()]);const c={offline:0,available:0,offered:0,busy:0,paused:0};drivers.forEach(d=>c[d.availabilityStatus||(!d.online?'offline':'available')]=(c[d.availabilityStatus||(!d.online?'offline':'available')]||0)+1);res.json({drivers:c,rides:rides.map(r=>({id:idOf(r),status:r.status,dispatchStatus:r.dispatchStatus,pickup:r.pickup,destination:r.destination,driverId:r.driverId,offerDriverId:r.currentOfferDriverId,radiusKm:r.searchRadiusKm,createdAt:r.createdAt}))});});

  setInterval(async()=>{try{const expired=await Ride.find({status:'pending',dispatchStatus:'offered',offerExpiresAt:{$lte:new Date()}}).select('_id currentOfferDriverId').lean();for(const r of expired)await expireOffer(r._id,r.currentOfferDriverId);}catch{}},5000).unref?.();
  console.log(`[DISPATCH] smart dispatcher enabled, offer=${OFFER_SECONDS}s, radii=${SEARCH_RADII.join('/')}`);
};
