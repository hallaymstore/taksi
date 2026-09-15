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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMeNow!2026';
const NOMINATIM_USER_AGENT = process.env.NOMINATIM_USER_AGENT || 'HALLAYM-Taxi/1.0 (contact: hallaymstore@gmail.com)';

function normalizePhone(v = '') {
  const digits = String(v).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 9) return `+998${digits}`;
  if (digits.startsWith('998')) return `+${digits}`;
  return `+${digits}`;
}
function safeText(v, max = 180) { return String(v || '').trim().slice(0, max); }
function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || 0)); }
function haversineKm(a, b) {
  if (!a || !b) return 0;
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}
function idOf(v) { return String(v?._id || v?.id || v || ''); }
function publicUser(u) {
  if (!u) return null;
  return { id: idOf(u), name: u.name, phone: u.phone, email: u.email || '', role: u.role, status: u.status, avatar: u.avatar || '', createdAt: u.createdAt };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false }));

let mongoReady = false;
let memory = { users: [], drivers: [], rides: [], settings: null };

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, unique: true, index: true },
  email: { type: String, default: '' },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['client', 'driver', 'admin'], default: 'client', index: true },
  status: { type: String, enum: ['active', 'blocked'], default: 'active' },
  avatar: { type: String, default: '' }
}, { timestamps: true });
const driverSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, index: true },
  carMake: String, carModel: String, carColor: String, plate: String, licenseNo: String,
  vehicleClass: { type: String, enum: ['economy', 'comfort', 'business'], default: 'economy' },
  approved: { type: Boolean, default: false }, online: { type: Boolean, default: false },
  location: { lat: Number, lng: Number }, rating: { type: Number, default: 5 }, completedRides: { type: Number, default: 0 }
}, { timestamps: true });
const pointSchema = new mongoose.Schema({ label: String, lat: Number, lng: Number }, { _id: false });
const rideSchema = new mongoose.Schema({
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  pickup: pointSchema, destination: pointSchema,
  vehicleClass: { type: String, enum: ['economy', 'comfort', 'business'], default: 'economy' },
  paymentMethod: { type: String, enum: ['cash', 'click', 'payme'], default: 'cash' },
  distanceKm: Number, fare: Number, note: String,
  status: { type: String, enum: ['pending', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled'], default: 'pending', index: true },
  cancelReason: String, rating: Number, sos: { type: Boolean, default: false },
  acceptedAt: Date, startedAt: Date, completedAt: Date
}, { timestamps: true });
const settingsSchema = new mongoose.Schema({
  key: { type: String, default: 'pricing', unique: true },
  baseFare: { type: Number, default: 5000 }, perKm: { type: Number, default: 2500 }, minimumFare: { type: Number, default: 7000 }, serviceFee: { type: Number, default: 0 },
  economyMultiplier: { type: Number, default: 1 }, comfortMultiplier: { type: Number, default: 1.35 }, businessMultiplier: { type: Number, default: 1.8 }
}, { timestamps: true });
const User = mongoose.model('User', userSchema);
const Driver = mongoose.model('Driver', driverSchema);
const Ride = mongoose.model('Ride', rideSchema);
const Settings = mongoose.model('Settings', settingsSchema);

async function initData() {
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  if (mongoReady) {
    let admin = await User.findOne({ role: 'admin' });
    if (!admin) admin = await User.create({ name: 'HALLAYM Admin', phone: ADMIN_PHONE, passwordHash: hash, role: 'admin' });
    await Settings.findOneAndUpdate({ key: 'pricing' }, { $setOnInsert: { key: 'pricing' } }, { upsert: true, new: true });
    return;
  }
  if (!memory.users.some(u => u.role === 'admin')) {
    memory.users.push({ id: crypto.randomUUID(), name: 'HALLAYM Admin', phone: ADMIN_PHONE, email: '', passwordHash: hash, role: 'admin', status: 'active', avatar: '', createdAt: new Date().toISOString() });
  }
  memory.settings ||= { key: 'pricing', baseFare: 5000, perKm: 2500, minimumFare: 7000, serviceFee: 0, economyMultiplier: 1, comfortMultiplier: 1.35, businessMultiplier: 1.8 };
}

async function connectDatabase() {
  if (!MONGODB_URI) { console.warn('[DB] MONGODB_URI missing: using temporary in-memory data store.'); await initData(); return; }
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 9000 });
    mongoReady = true;
    console.log('[DB] MongoDB connected');
  } catch (err) {
    console.error('[DB] MongoDB unavailable, using temporary in-memory store:', err.message);
  }
  await initData();
}

async function findUserByPhone(phone) {
  return mongoReady ? User.findOne({ phone }) : memory.users.find(u => u.phone === phone) || null;
}
async function findUserById(id) {
  if (!id) return null;
  if (mongoReady) { try { return await User.findById(id); } catch { return null; } }
  return memory.users.find(u => idOf(u) === String(id)) || null;
}
async function getSettings() {
  if (mongoReady) return (await Settings.findOne({ key: 'pricing' }).lean()) || {};
  return { ...memory.settings };
}
function tokenFor(user) { return jwt.sign({ sub: idOf(user), role: user.role }, JWT_SECRET, { expiresIn: '30d' }); }
function auth(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Avtorizatsiya talab qilinadi' });
  try { req.auth = jwt.verify(token, JWT_SECRET); next(); } catch { return res.status(401).json({ error: 'Sessiya yaroqsiz yoki muddati tugagan' }); }
}
function role(...roles) { return (req, res, next) => roles.includes(req.auth?.role) ? next() : res.status(403).json({ error: 'Ruxsat yetarli emas' }); }
async function ensureActive(req, res, next) {
  const u = await findUserById(req.auth.sub);
  if (!u || u.status !== 'active') return res.status(403).json({ error: 'Akkaunt bloklangan yoki topilmadi' });
  req.user = u; next();
}

app.get('/health', (_req, res) => res.json({ ok: true, app: APP_NAME, db: mongoReady ? 'mongodb' : 'memory', time: new Date().toISOString() }));
app.get('/api/meta', (_req, res) => res.json({ appName: APP_NAME, persistence: mongoReady ? 'mongodb' : 'memory' }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const name = safeText(req.body.name, 80); const phone = normalizePhone(req.body.phone); const password = String(req.body.password || ''); const requestedRole = req.body.role === 'driver' ? 'driver' : 'client';
    if (name.length < 2 || phone.length < 10 || password.length < 6) return res.status(400).json({ error: 'Ism, telefon va kamida 6 belgili parol kiriting' });
    if (await findUserByPhone(phone)) return res.status(409).json({ error: 'Bu telefon raqam allaqachon ro‘yxatdan o‘tgan' });
    const passwordHash = await bcrypt.hash(password, 10);
    let u;
    if (mongoReady) {
      u = await User.create({ name, phone, email: safeText(req.body.email, 120), passwordHash, role: requestedRole });
      if (requestedRole === 'driver') await Driver.create({ userId: u._id });
    } else {
      u = { id: crypto.randomUUID(), name, phone, email: safeText(req.body.email, 120), passwordHash, role: requestedRole, status: 'active', avatar: '', createdAt: new Date().toISOString() };
      memory.users.push(u);
      if (requestedRole === 'driver') memory.drivers.push({ id: crypto.randomUUID(), userId: u.id, carMake: '', carModel: '', carColor: '', plate: '', licenseNo: '', vehicleClass: 'economy', approved: false, online: false, location: null, rating: 5, completedRides: 0 });
    }
    res.status(201).json({ token: tokenFor(u), user: publicUser(u) });
  } catch (err) { res.status(500).json({ error: 'Ro‘yxatdan o‘tishda xato', detail: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone); const password = String(req.body.password || '');
    const u = await findUserByPhone(phone);
    if (!u || !(await bcrypt.compare(password, u.passwordHash))) return res.status(401).json({ error: 'Telefon yoki parol noto‘g‘ri' });
    if (u.status !== 'active') return res.status(403).json({ error: 'Akkaunt bloklangan' });
    res.json({ token: tokenFor(u), user: publicUser(u) });
  } catch (err) { res.status(500).json({ error: 'Kirishda xato', detail: err.message }); }
});

app.get('/api/me', auth, ensureActive, async (req, res) => {
  let driver = null;
  if (req.user.role === 'driver') driver = mongoReady ? await Driver.findOne({ userId: req.user._id }).lean() : memory.drivers.find(d => idOf(d.userId) === idOf(req.user));
  res.json({ user: publicUser(req.user), driver });
});
app.patch('/api/me', auth, ensureActive, async (req, res) => {
  const patch = { name: safeText(req.body.name || req.user.name, 80), avatar: safeText(req.body.avatar || req.user.avatar, 500) };
  if (mongoReady) req.user = await User.findByIdAndUpdate(req.user._id, patch, { new: true });
  else Object.assign(req.user, patch);
  res.json({ user: publicUser(req.user) });
});

app.get('/api/pricing', async (_req, res) => res.json(await getSettings()));
app.put('/api/admin/pricing', auth, role('admin'), ensureActive, async (req, res) => {
  const patch = {
    baseFare: clamp(req.body.baseFare, 0, 1e7), perKm: clamp(req.body.perKm, 0, 1e7), minimumFare: clamp(req.body.minimumFare, 0, 1e7), serviceFee: clamp(req.body.serviceFee, 0, 1e7),
    economyMultiplier: clamp(req.body.economyMultiplier, .5, 5), comfortMultiplier: clamp(req.body.comfortMultiplier, .5, 5), businessMultiplier: clamp(req.body.businessMultiplier, .5, 5)
  };
  if (mongoReady) await Settings.findOneAndUpdate({ key: 'pricing' }, patch, { new: true, upsert: true }); else Object.assign(memory.settings, patch);
  io.emit('pricing:updated', await getSettings());
  res.json(await getSettings());
});

app.get('/api/driver/profile', auth, role('driver'), ensureActive, async (req, res) => {
  const d = mongoReady ? await Driver.findOne({ userId: req.user._id }).lean() : memory.drivers.find(x => idOf(x.userId) === idOf(req.user));
  res.json(d || {});
});
app.put('/api/driver/profile', auth, role('driver'), ensureActive, async (req, res) => {
  const patch = { carMake: safeText(req.body.carMake, 60), carModel: safeText(req.body.carModel, 60), carColor: safeText(req.body.carColor, 40), plate: safeText(req.body.plate, 20).toUpperCase(), licenseNo: safeText(req.body.licenseNo, 40), vehicleClass: ['economy','comfort','business'].includes(req.body.vehicleClass) ? req.body.vehicleClass : 'economy' };
  let d;
  if (mongoReady) d = await Driver.findOneAndUpdate({ userId: req.user._id }, patch, { new: true, upsert: true }).lean();
  else { d = memory.drivers.find(x => idOf(x.userId) === idOf(req.user)); if (!d) { d = { id: crypto.randomUUID(), userId: idOf(req.user), approved: false, online: false, rating: 5, completedRides: 0 }; memory.drivers.push(d); } Object.assign(d, patch); }
  res.json(d);
});
app.patch('/api/driver/online', auth, role('driver'), ensureActive, async (req, res) => {
  let d = mongoReady ? await Driver.findOne({ userId: req.user._id }) : memory.drivers.find(x => idOf(x.userId) === idOf(req.user));
  if (!d?.approved && req.body.online) return res.status(403).json({ error: 'Admin tasdiqlamaguncha onlayn bo‘lib bo‘lmaydi' });
  if (mongoReady) { d.online = !!req.body.online; await d.save(); } else d.online = !!req.body.online;
  io.to(`user:${idOf(req.user)}`).emit('driver:online', { online: d.online });
  res.json({ online: d.online });
});
app.patch('/api/driver/location', auth, role('driver'), ensureActive, async (req, res) => {
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Koordinata xato' });
  let d = mongoReady ? await Driver.findOneAndUpdate({ userId: req.user._id }, { location: { lat, lng } }, { new: true }) : memory.drivers.find(x => idOf(x.userId) === idOf(req.user));
  if (!mongoReady && d) d.location = { lat, lng };
  const active = mongoReady ? await Ride.findOne({ driverId: req.user._id, status: { $in: ['accepted','arrived','in_progress'] } }).lean() : memory.rides.find(r => idOf(r.driverId) === idOf(req.user) && ['accepted','arrived','in_progress'].includes(r.status));
  if (active) io.to(`user:${idOf(active.clientId)}`).emit('driver:location', { rideId: idOf(active), lat, lng });
  res.json({ ok: true });
});

function calcFare(distanceKm, klass, s) {
  const mult = klass === 'business' ? s.businessMultiplier : klass === 'comfort' ? s.comfortMultiplier : s.economyMultiplier;
  return Math.ceil(Math.max(s.minimumFare, (s.baseFare + distanceKm * s.perKm + s.serviceFee) * mult) / 500) * 500;
}

app.post('/api/rides', auth, role('client'), ensureActive, async (req, res) => {
  const p = req.body.pickup || {}, d = req.body.destination || {};
  const pickup = { label: safeText(p.label, 180), lat: Number(p.lat), lng: Number(p.lng) };
  const destination = { label: safeText(d.label, 180), lat: Number(d.lat), lng: Number(d.lng) };
  if (![pickup.lat,pickup.lng,destination.lat,destination.lng].every(Number.isFinite)) return res.status(400).json({ error: 'Jo‘nash va manzil nuqtalarini tanlang' });
  const existing = mongoReady ? await Ride.findOne({ clientId: req.user._id, status: { $in: ['pending','accepted','arrived','in_progress'] } }) : memory.rides.find(r => idOf(r.clientId) === idOf(req.user) && ['pending','accepted','arrived','in_progress'].includes(r.status));
  if (existing) return res.status(409).json({ error: 'Sizda allaqachon faol buyurtma bor', rideId: idOf(existing) });
  const settings = await getSettings(); const distanceKm = Math.max(.3, haversineKm(pickup, destination) * 1.18);
  const vehicleClass = ['economy','comfort','business'].includes(req.body.vehicleClass) ? req.body.vehicleClass : 'economy';
  const rideData = { clientId: mongoReady ? req.user._id : idOf(req.user), driverId: null, pickup, destination, vehicleClass, paymentMethod: ['cash','click','payme'].includes(req.body.paymentMethod) ? req.body.paymentMethod : 'cash', distanceKm: Number(distanceKm.toFixed(2)), fare: calcFare(distanceKm, vehicleClass, settings), note: safeText(req.body.note, 240), status: 'pending', sos: false, createdAt: new Date().toISOString() };
  let ride;
  if (mongoReady) ride = await Ride.create(rideData); else { ride = { id: crypto.randomUUID(), ...rideData }; memory.rides.unshift(ride); }
  io.to('role:driver').emit('ride:new', ride);
  io.to('role:admin').emit('admin:refresh');
  res.status(201).json(ride);
});

app.get('/api/rides/mine', auth, ensureActive, async (req, res) => {
  let rides;
  if (mongoReady) {
    const q = req.user.role === 'client' ? { clientId: req.user._id } : req.user.role === 'driver' ? { driverId: req.user._id } : {};
    rides = await Ride.find(q).sort({ createdAt: -1 }).limit(100).lean();
  } else {
    rides = memory.rides.filter(r => req.user.role === 'admin' || (req.user.role === 'client' ? idOf(r.clientId) === idOf(req.user) : idOf(r.driverId) === idOf(req.user))).slice(0, 100);
  }
  res.json(rides);
});

app.get('/api/rides/available', auth, role('driver'), ensureActive, async (req, res) => {
  const d = mongoReady ? await Driver.findOne({ userId: req.user._id }).lean() : memory.drivers.find(x => idOf(x.userId) === idOf(req.user));
  if (!d?.approved) return res.json([]);
  const rides = mongoReady ? await Ride.find({ status: 'pending', driverId: null }).sort({ createdAt: -1 }).limit(50).lean() : memory.rides.filter(r => r.status === 'pending' && !r.driverId).slice(0, 50);
  res.json(rides);
});

app.post('/api/rides/:id/accept', auth, role('driver'), ensureActive, async (req, res) => {
  const d = mongoReady ? await Driver.findOne({ userId: req.user._id }) : memory.drivers.find(x => idOf(x.userId) === idOf(req.user));
  if (!d?.approved || !d?.online) return res.status(403).json({ error: 'Avval admin tasdig‘i va Onlayn holat talab qilinadi' });
  let ride;
  if (mongoReady) ride = await Ride.findOneAndUpdate({ _id: req.params.id, status: 'pending', driverId: null }, { driverId: req.user._id, status: 'accepted', acceptedAt: new Date() }, { new: true }).lean();
  else { ride = memory.rides.find(r => idOf(r) === req.params.id && r.status === 'pending' && !r.driverId); if (ride) Object.assign(ride, { driverId: idOf(req.user), status: 'accepted', acceptedAt: new Date().toISOString() }); }
  if (!ride) return res.status(409).json({ error: 'Buyurtmani boshqa haydovchi olgan yoki u yopilgan' });
  io.to(`user:${idOf(ride.clientId)}`).emit('ride:updated', ride); io.to('role:driver').emit('ride:taken', { rideId: idOf(ride) }); io.to('role:admin').emit('admin:refresh');
  res.json(ride);
});

app.patch('/api/rides/:id/status', auth, role('driver','admin'), ensureActive, async (req, res) => {
  const next = req.body.status; const allowed = ['arrived','in_progress','completed','cancelled'];
  if (!allowed.includes(next)) return res.status(400).json({ error: 'Status noto‘g‘ri' });
  let ride = mongoReady ? await Ride.findById(req.params.id) : memory.rides.find(r => idOf(r) === req.params.id);
  if (!ride) return res.status(404).json({ error: 'Buyurtma topilmadi' });
  if (req.user.role === 'driver' && idOf(ride.driverId) !== idOf(req.user)) return res.status(403).json({ error: 'Bu buyurtma sizniki emas' });
  ride.status = next;
  if (next === 'in_progress') ride.startedAt = new Date();
  if (next === 'completed') ride.completedAt = new Date();
  if (mongoReady) await ride.save();
  if (next === 'completed' && ride.driverId) {
    if (mongoReady) await Driver.updateOne({ userId: ride.driverId }, { $inc: { completedRides: 1 } });
    else { const dp = memory.drivers.find(x => idOf(x.userId) === idOf(ride.driverId)); if (dp) dp.completedRides = (dp.completedRides || 0) + 1; }
  }
  const out = mongoReady ? ride.toObject() : ride;
  io.to(`user:${idOf(ride.clientId)}`).emit('ride:updated', out); io.to(`user:${idOf(ride.driverId)}`).emit('ride:updated', out); io.to('role:admin').emit('admin:refresh');
  res.json(out);
});

app.post('/api/rides/:id/cancel', auth, ensureActive, async (req, res) => {
  let ride = mongoReady ? await Ride.findById(req.params.id) : memory.rides.find(r => idOf(r) === req.params.id);
  if (!ride) return res.status(404).json({ error: 'Buyurtma topilmadi' });
  const uid = idOf(req.user); if (req.user.role !== 'admin' && uid !== idOf(ride.clientId) && uid !== idOf(ride.driverId)) return res.status(403).json({ error: 'Ruxsat yo‘q' });
  if (['completed','cancelled'].includes(ride.status)) return res.status(409).json({ error: 'Bu buyurtma yopilgan' });
  ride.status = 'cancelled'; ride.cancelReason = safeText(req.body.reason, 180);
  if (mongoReady) await ride.save();
  const out = mongoReady ? ride.toObject() : ride; io.to(`user:${idOf(ride.clientId)}`).emit('ride:updated', out); if (ride.driverId) io.to(`user:${idOf(ride.driverId)}`).emit('ride:updated', out); io.to('role:admin').emit('admin:refresh');
  res.json(out);
});

app.post('/api/rides/:id/rate', auth, role('client'), ensureActive, async (req, res) => {
  const rating = clamp(req.body.rating, 1, 5);
  let ride = mongoReady ? await Ride.findOne({ _id: req.params.id, clientId: req.user._id, status: 'completed' }) : memory.rides.find(r => idOf(r) === req.params.id && idOf(r.clientId) === idOf(req.user) && r.status === 'completed');
  if (!ride) return res.status(404).json({ error: 'Baholash uchun yakunlangan buyurtma topilmadi' });
  ride.rating = rating; if (mongoReady) await ride.save();
  if (ride.driverId) {
    if (mongoReady) {
      const completed = await Ride.find({ driverId: ride.driverId, status: 'completed', rating: { $exists: true } }).select('rating').lean();
      const avg = completed.reduce((a,x) => a + Number(x.rating || 0), 0) / Math.max(1, completed.length); await Driver.updateOne({ userId: ride.driverId }, { rating: Number(avg.toFixed(2)) });
    } else {
      const vals = memory.rides.filter(r => idOf(r.driverId) === idOf(ride.driverId) && r.status === 'completed' && r.rating).map(r => r.rating); const dp = memory.drivers.find(d => idOf(d.userId) === idOf(ride.driverId)); if (dp) dp.rating = vals.reduce((a,b) => a+b, 0) / Math.max(1, vals.length);
    }
  }
  res.json({ ok: true, rating });
});

app.post('/api/rides/:id/sos', auth, ensureActive, async (req, res) => {
  let ride = mongoReady ? await Ride.findById(req.params.id) : memory.rides.find(r => idOf(r) === req.params.id);
  if (!ride) return res.status(404).json({ error: 'Buyurtma topilmadi' });
  const uid = idOf(req.user); if (uid !== idOf(ride.clientId) && uid !== idOf(ride.driverId)) return res.status(403).json({ error: 'Ruxsat yo‘q' });
  ride.sos = true; if (mongoReady) await ride.save(); io.to('role:admin').emit('sos', { rideId: idOf(ride), by: uid, time: new Date().toISOString() });
  res.json({ ok: true });
});

app.get('/api/admin/stats', auth, role('admin'), ensureActive, async (_req, res) => {
  if (mongoReady) {
    const [users, clients, drivers, pendingDrivers, rides, active, completed, revenueAgg] = await Promise.all([
      User.countDocuments(), User.countDocuments({ role: 'client' }), User.countDocuments({ role: 'driver' }), Driver.countDocuments({ approved: false }), Ride.countDocuments(), Ride.countDocuments({ status: { $in: ['pending','accepted','arrived','in_progress'] } }), Ride.countDocuments({ status: 'completed' }), Ride.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$fare' } } }])
    ]);
    return res.json({ users, clients, drivers, pendingDrivers, rides, active, completed, revenue: revenueAgg[0]?.total || 0 });
  }
  res.json({ users: memory.users.length, clients: memory.users.filter(u=>u.role==='client').length, drivers: memory.users.filter(u=>u.role==='driver').length, pendingDrivers: memory.drivers.filter(d=>!d.approved).length, rides: memory.rides.length, active: memory.rides.filter(r=>['pending','accepted','arrived','in_progress'].includes(r.status)).length, completed: memory.rides.filter(r=>r.status==='completed').length, revenue: memory.rides.filter(r=>r.status==='completed').reduce((a,r)=>a+(r.fare||0),0) });
});
app.get('/api/admin/users', auth, role('admin'), ensureActive, async (_req, res) => {
  const users = mongoReady ? await User.find().sort({ createdAt: -1 }).select('-passwordHash').lean() : memory.users.map(publicUser);
  res.json(users);
});
app.patch('/api/admin/users/:id/status', auth, role('admin'), ensureActive, async (req, res) => {
  const status = req.body.status === 'blocked' ? 'blocked' : 'active';
  let u = mongoReady ? await User.findByIdAndUpdate(req.params.id, { status }, { new: true }).select('-passwordHash').lean() : memory.users.find(x => idOf(x) === req.params.id);
  if (!mongoReady && u) u.status = status;
  if (!u) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  io.to(`user:${req.params.id}`).emit('account:status', { status }); res.json(publicUser(u));
});
app.get('/api/admin/drivers', auth, role('admin'), ensureActive, async (_req, res) => {
  if (mongoReady) {
    const drivers = await Driver.find().sort({ createdAt: -1 }).lean();
    const ids = drivers.map(d => d.userId); const users = await User.find({ _id: { $in: ids } }).select('name phone status').lean(); const map = new Map(users.map(u => [idOf(u), u]));
    return res.json(drivers.map(d => ({ ...d, user: publicUser(map.get(idOf(d.userId))) })));
  }
  res.json(memory.drivers.map(d => ({ ...d, user: publicUser(memory.users.find(u => idOf(u) === idOf(d.userId))) })));
});
app.patch('/api/admin/drivers/:id/approve', auth, role('admin'), ensureActive, async (req, res) => {
  const approved = !!req.body.approved;
  let d = mongoReady ? await Driver.findOneAndUpdate({ userId: req.params.id }, { approved, ...(approved ? {} : { online: false }) }, { new: true }).lean() : memory.drivers.find(x => idOf(x.userId) === req.params.id);
  if (!mongoReady && d) { d.approved = approved; if (!approved) d.online = false; }
  if (!d) return res.status(404).json({ error: 'Haydovchi topilmadi' });
  io.to(`user:${req.params.id}`).emit('driver:approval', { approved }); res.json(d);
});
app.get('/api/admin/rides', auth, role('admin'), ensureActive, async (_req, res) => {
  const rides = mongoReady ? await Ride.find().sort({ createdAt: -1 }).limit(250).lean() : memory.rides.slice(0,250);
  res.json(rides);
});

app.get('/api/geocode/search', async (req, res) => {
  const q = safeText(req.query.q, 140); if (q.length < 3) return res.json([]);
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search'); url.searchParams.set('format','jsonv2'); url.searchParams.set('limit','6'); url.searchParams.set('addressdetails','1'); url.searchParams.set('countrycodes','uz'); url.searchParams.set('q',q);
    const r = await fetch(url, { headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept-Language': 'uz,ru;q=0.8,en;q=0.6' } }); const data = await r.json();
    res.json((Array.isArray(data) ? data : []).map(x => ({ label: x.display_name, lat: Number(x.lat), lng: Number(x.lon) })));
  } catch { res.json([]); }
});
app.get('/api/geocode/reverse', async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng); if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Koordinata xato' });
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse'); url.searchParams.set('format','jsonv2'); url.searchParams.set('lat',lat); url.searchParams.set('lon',lng); url.searchParams.set('zoom','18');
    const r = await fetch(url, { headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept-Language': 'uz,ru;q=0.8,en;q=0.6' } }); const x = await r.json(); res.json({ label: x.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng });
  } catch { res.json({ label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng }); }
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  try { socket.auth = jwt.verify(token, JWT_SECRET); next(); } catch { next(new Error('unauthorized')); }
});
io.on('connection', async socket => {
  const u = await findUserById(socket.auth.sub); if (!u || u.status !== 'active') return socket.disconnect(true);
  socket.join(`user:${idOf(u)}`); socket.join(`role:${u.role}`);
  socket.emit('connected', { ok: true, userId: idOf(u) });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server xatosi' }); });

connectDatabase().then(() => server.listen(PORT, '0.0.0.0', () => console.log(`[${APP_NAME}] listening on :${PORT}`)));
