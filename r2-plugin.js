'use strict';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const BUCKET = process.env.R2_BUCKET || '';
const PUBLIC_BASE = String(process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');
const ENDPOINT = process.env.R2_S3_ENDPOINT || (ACCOUNT_ID ? `https://${ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
const JWT_SECRET = process.env.JWT_SECRET || '';
const MAX_BYTES = 12 * 1024 * 1024;
const configured = Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET && PUBLIC_BASE && JWT_SECRET);

const s3 = configured ? new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
}) : null;

function idOf(v) { return String(v?._id || v?.id || v || ''); }
function safe(v, max = 120) { return String(v || '').trim().slice(0, max); }
function extensionFor(mime, name = '') {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  if (map[mime]) return map[mime];
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1];
  return ['jpg','jpeg','png','webp','pdf'].includes(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : '';
}

module.exports = function attachR2(app) {
  if (!app) throw new Error('Express app not captured');

  const uploadSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    kind: { type: String, enum: ['avatar','license','idcard','vehicle','selfie'], index: true },
    key: { type: String, required: true }, url: { type: String, required: true }, mime: String,
    originalName: String, size: Number, status: { type: String, enum: ['active','deleted'], default: 'active' }
  }, { timestamps: true });
  const Upload = mongoose.models.TaxiUpload || mongoose.model('TaxiUpload', uploadSchema);

  async function auth(req, res, next) {
    try {
      const raw = req.headers.authorization || '';
      const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
      if (!token || !JWT_SECRET) return res.status(401).json({ error: 'Avtorizatsiya talab qilinadi' });
      const payload = jwt.verify(token, JWT_SECRET);
      const User = mongoose.model('User');
      const user = await User.findById(payload.sub);
      if (!user || user.status !== 'active') return res.status(403).json({ error: 'Akkaunt faol emas' });
      req.storageUser = user;
      next();
    } catch (e) { return res.status(401).json({ error: 'Sessiya yaroqsiz' }); }
  }

  app.get('/api/storage/status', async (_req, res) => {
    if (!configured) return res.json({ configured: false, provider: 'r2' });
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
      res.json({ configured: true, reachable: true, provider: 'r2', bucket: BUCKET, publicBase: PUBLIC_BASE });
    } catch (e) {
      res.status(503).json({ configured: true, reachable: false, provider: 'r2', bucket: BUCKET, error: 'R2 ulanishi tekshiruvida xato' });
    }
  });

  const rawUpload = express.raw({ type: () => true, limit: MAX_BYTES });
  app.post('/api/uploads/:kind', auth, rawUpload, async (req, res) => {
    try {
      if (!configured) return res.status(503).json({ error: 'R2 sozlanmagan' });
      const kind = safe(req.params.kind, 20).toLowerCase();
      const allowedKinds = ['avatar','license','idcard','vehicle','selfie'];
      if (!allowedKinds.includes(kind)) return res.status(400).json({ error: 'Fayl turi noto‘g‘ri' });
      if (kind !== 'avatar' && req.storageUser.role !== 'driver') return res.status(403).json({ error: 'Bu upload faqat haydovchilar uchun' });
      const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
      const originalName = decodeURIComponent(String(req.headers['x-file-name'] || 'file'));
      const ext = extensionFor(mime, originalName);
      if (!ext || !['image/jpeg','image/png','image/webp','application/pdf'].includes(mime)) return res.status(415).json({ error: 'Faqat JPG, PNG, WEBP yoki PDF qabul qilinadi' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Fayl bo‘sh' });
      if (req.body.length > MAX_BYTES) return res.status(413).json({ error: 'Fayl 12 MB dan katta bo‘lmasin' });

      const uid = idOf(req.storageUser);
      const key = `taxi/${uid}/${kind}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: req.body, ContentType: mime, CacheControl: kind === 'avatar' ? 'public,max-age=31536000,immutable' : 'private,max-age=3600' }));
      const url = `${PUBLIC_BASE}/${key}`;
      const row = await Upload.create({ userId: req.storageUser._id, kind, key, url, mime, originalName: safe(originalName, 180), size: req.body.length });

      if (kind === 'avatar') {
        const User = mongoose.model('User');
        await User.updateOne({ _id: req.storageUser._id }, { avatar: url });
      } else {
        const Driver = mongoose.model('Driver');
        await Driver.updateOne({ userId: req.storageUser._id }, { documentStatus: 'pending', documentNote: '' });
      }
      res.status(201).json({ id: idOf(row), kind, url, size: req.body.length, status: 'uploaded' });
    } catch (e) {
      console.error('[R2 upload]', e.message);
      res.status(500).json({ error: 'Faylni R2 ga yuklashda xato' });
    }
  });

  app.get('/api/uploads/mine', auth, async (req, res) => {
    const rows = await Upload.find({ userId: req.storageUser._id, status: 'active' }).sort({ createdAt: -1 }).lean();
    res.json(rows.map(x => ({ id:idOf(x), kind:x.kind, url:x.url, mime:x.mime, originalName:x.originalName, size:x.size, createdAt:x.createdAt })));
  });

  app.delete('/api/uploads/:id', auth, async (req, res) => {
    const row = await Upload.findOne({ _id:req.params.id, userId:req.storageUser._id, status:'active' });
    if (!row) return res.status(404).json({ error: 'Fayl topilmadi' });
    try { if (configured) await s3.send(new DeleteObjectCommand({ Bucket:BUCKET, Key:row.key })); } catch {}
    row.status = 'deleted'; await row.save(); res.json({ ok:true });
  });

  app.get('/api/admin/uploads', auth, async (req, res) => {
    if (req.storageUser.role !== 'admin') return res.status(403).json({ error: 'Admin ruxsati kerak' });
    const q = { status:'active' };
    if (req.query.userId) q.userId = req.query.userId;
    const rows = await Upload.find(q).sort({ createdAt:-1 }).limit(300).lean();
    const User = mongoose.model('User');
    const ids = [...new Set(rows.map(x=>idOf(x.userId)))];
    const users = await User.find({ _id:{ $in:ids } }).select('name phone role').lean();
    const um = new Map(users.map(u=>[idOf(u),{id:idOf(u),name:u.name,phone:u.phone,role:u.role}]));
    res.json(rows.map(x=>({ id:idOf(x), user:um.get(idOf(x.userId))||null, kind:x.kind, url:x.url, mime:x.mime, originalName:x.originalName, size:x.size, createdAt:x.createdAt })));
  });

  console.log(`[R2] plugin ${configured ? 'configured' : 'disabled'} (${BUCKET || 'no bucket'})`);
};
