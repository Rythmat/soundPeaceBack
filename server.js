import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { CLIP_LIMITS, LimitError, isDeviceId, releaseUploads, reserveUploads } from './devices.js';

const PORT = process.env.PORT || 3000;
const BUCKET = process.env.GCS_BUCKET;
const PREFIX = 'clips/';
const MAX_BYTES = 2 * 1024 * 1024;

// A device's whole allowance can arrive in one upload, so the per-device limits double
// as per-request limits. The category also starts every object name, e.g.
// clips/chaos-1730000000000-<uuid>.wav
const MAX_FILES = Math.max(...Object.values(CLIP_LIMITS));

// Frontend origins allowed to call the API, e.g. "https://sound-peace.onrender.com".
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

if (!BUCKET) {
  console.error('GCS_BUCKET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Auth uses Application Default Credentials: `gcloud auth application-default login`
// locally, GOOGLE_APPLICATION_CREDENTIALS pointing at a key file, or the attached
// service account when deployed on Cloud Run / GCE.
const bucket = new Storage().bucket(BUCKET);
// Per-device upload records (see devices.js). Same credentials and project as the bucket.
const db = new Firestore({ databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

// Browsers report types like "audio/webm;codecs=opus", so we match on the base type.
const EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

const app = express();

// CORS alone only stops browsers reading the response; a cross-site form POST would
// still be stored. So browser requests from any other origin are refused outright.
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});
app.use(cors({ origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] }));

// Render's health check, and the frontend's wake-up ping for a sleeping free instance.
app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/clips', upload.array('audio', MAX_FILES), async (req, res) => {
  const category = req.body?.category;
  const limit = CLIP_LIMITS[category];
  if (!limit) return res.status(400).json({ error: 'category must be "chaos" or "peace"' });

  const deviceId = req.body?.deviceId;
  if (!isDeviceId(deviceId)) return res.status(400).json({ error: 'Missing or invalid deviceId' });

  const files = req.files ?? [];
  if (files.length === 0) return res.status(400).json({ error: 'Missing "audio" file field' });
  if (files.length > limit) {
    return res.status(400).json({ error: `At most ${limit} ${category} clip(s) per upload` });
  }

  // Check every file before writing any, so a bad file doesn't leave half a batch behind.
  const extensions = files.map((f) => EXTENSIONS[f.mimetype.split(';')[0]]);
  const badIndex = extensions.findIndex((ext) => !ext);
  if (badIndex !== -1) {
    return res.status(415).json({ error: `Unsupported type: ${files[badIndex].mimetype}` });
  }

  // Count the clips against the device's allowance before storing them, and give the
  // allowance back if storing fails.
  let record;
  try {
    record = await reserveUploads(db, deviceId, category, files.length);
  } catch (err) {
    if (err instanceof LimitError) return res.status(409).json({ error: err.message, record: err.record });
    throw err;
  }

  let ids;
  try {
    ids = await Promise.all(
      files.map(async (file, i) => {
        const id = `${category}-${Date.now()}-${crypto.randomUUID()}.${extensions[i]}`;
        await bucket.file(PREFIX + id).save(file.buffer, {
          contentType: file.mimetype,
          resumable: false,
        });
        return id;
      }),
    );
  } catch (err) {
    await releaseUploads(db, deviceId, category, files.length).catch((releaseErr) => {
      console.error('Could not release reserved uploads', releaseErr);
    });
    throw err;
  }

  res.status(201).json({ ids, record });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT} (bucket: ${BUCKET})`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
