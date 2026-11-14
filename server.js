import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { Firestore } from '@google-cloud/firestore';
import { IdempotencyStrategy, Storage } from '@google-cloud/storage';
import { CLIP_LIMITS, LimitError, checkAllowance, countUploads, isUuid, readDevice } from './devices.js';

const PORT = process.env.PORT || 3000;
const BUCKET = process.env.GCS_BUCKET;
const PREFIX = 'clips/';
// A full-length clip is 5.25 s of 16-bit mono at the device's sample rate: about 0.5 MB
// at 48 kHz, and still under this limit at 384 kHz.
const MAX_BYTES = 4 * 1024 * 1024;

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
// service account when deployed on Cloud Run / GCE. Every Storage call here is safe to
// repeat (uploads only ever create new objects, and deletes ignore objects that are
// already gone), so the client may retry all of them.
const bucket = new Storage({
  retryOptions: { idempotencyStrategy: IdempotencyStrategy.RetryAlways },
}).bucket(BUCKET);
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

// Stores one clip. The precondition makes a retry fail rather than overwrite, and since
// every name is new, an object that's already there can only be an earlier attempt of
// this same write that went through before its response was lost.
async function store(name, file) {
  try {
    await bucket.file(name).save(file.buffer, {
      contentType: file.mimetype,
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  } catch (err) {
    if (err.code !== 412) throw err;
  }
}

// Deletes clips this request stored but won't keep. A failure here only leaves a spare
// copy in the bucket, so it's logged rather than reported to the participant.
async function discard(names) {
  const results = await Promise.allSettled(
    names.map((name) => bucket.file(name).delete({ ignoreNotFound: true })),
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') console.error(`Could not delete ${names[i]}`, result.reason);
  });
}

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
  if (!isUuid(deviceId)) return res.status(400).json({ error: 'Missing or invalid deviceId' });

  // The browser sends the same upload ID each time it retries the same clips. Pages from
  // before upload IDs don't send one, so each of their requests counts as a new upload.
  const requestId = crypto.randomUUID();
  const uploadId = req.body?.uploadId ?? requestId;
  if (!isUuid(uploadId)) return res.status(400).json({ error: 'Invalid uploadId' });

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

  // Answer a retry of an upload that already went through (its response never reached
  // the browser) without storing it again, and turn away uploads over the limit before
  // storing anything.
  const device = await readDevice(db, deviceId);
  if (device.uploads[uploadId]) return res.json({ ids: [], record: device.record });
  try {
    checkAllowance(device.record, category, files.length);
  } catch (err) {
    if (err instanceof LimitError) return res.status(409).json({ error: err.message, record: err.record });
    throw err;
  }

  // Store first, count second. If this process dies in between, the clips are stored but
  // not counted, and the participant's retry stores them again: a spare copy. The other
  // order could count clips that were never stored, and a retry would be told they were.
  const names = files.map(
    (file, i) => `${PREFIX}${category}-${Date.now()}-${crypto.randomUUID()}.${extensions[i]}`,
  );
  const stored = await Promise.allSettled(files.map((file, i) => store(names[i], file)));
  const failure = stored.find((result) => result.status === 'rejected');
  if (failure) {
    // Nothing is counted and the participant will retry the whole batch, so don't leave
    // part of it behind.
    await discard(names.filter((name, i) => stored[i].status === 'fulfilled'));
    throw failure.reason;
  }

  let result;
  try {
    result = await countUploads(db, { deviceId, category, count: files.length, uploadId, requestId });
  } catch (err) {
    // A refusal means nothing was counted, so the clips go. Any other error might have
    // come after the count was committed, so the clips stay.
    if (err instanceof LimitError) {
      await discard(names);
      return res.status(409).json({ error: err.message, record: err.record });
    }
    throw err;
  }
  if (!result.counted) {
    // Another request for this upload got there first, and its clips are stored.
    await discard(names);
    return res.json({ ids: [], record: result.record });
  }

  res.status(201).json({ ids: names.map((name) => name.slice(PREFIX.length)), record: result.record });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Checks the credentials, bucket and database before taking any requests. If one is
// wrong the process exits, so the deploy fails instead of every upload failing while
// /healthz says all is well.
async function checkAccess() {
  const [granted] = await bucket.iam.testPermissions(['storage.objects.create', 'storage.objects.delete']);
  if (!granted['storage.objects.create']) {
    throw new Error(`These credentials can't create objects in gs://${BUCKET}`);
  }
  if (!granted['storage.objects.delete']) {
    console.warn(
      `These credentials can't delete objects in gs://${BUCKET}, so spare copies of clips ` +
        'from failed or repeated uploads will be left there.',
    );
  }
  // Not a valid device ID, so it can't be a real device's record.
  await db.collection('devices').doc('startup-check').get();
}

try {
  await checkAccess();
} catch (err) {
  console.error('Startup check failed:', err.message);
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT} (bucket: ${BUCKET})`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});

// Render sends SIGTERM before it stops this instance (for a deploy or a restart), then
// waits 30 s by default before killing it. Stop taking new connections and let the
// uploads in progress finish.
process.on('SIGTERM', () => {
  console.log('SIGTERM received; finishing requests in progress');
  server.close(() => process.exit(0));
});
