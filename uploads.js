import { FieldValue } from '@google-cloud/firestore';

// The frontend generates upload IDs with crypto.randomUUID(), which produces v4 UUIDs.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// One Firestore document per stored upload: uploads/<uploadId> = { requestId, createdAt },
// where requestId identifies the request that stored it. It lets the server answer a
// retry of an upload that already went through without storing the clips again.
function uploadRef(db, uploadId) {
  return db.collection('uploads').doc(uploadId);
}

// Whether an upload with this ID has already been stored and recorded.
export async function isRecorded(db, uploadId) {
  return (await uploadRef(db, uploadId).get()).exists;
}

// Records an upload whose clips are already stored. Returns false if another request
// recorded it first (its clips are stored, so this request's copies are spare).
// Firestore can run this more than once for one request when a commit's outcome is
// unclear, so a match on requestId means an earlier run of this same request committed.
export function recordUpload(db, uploadId, requestId) {
  const ref = uploadRef(db, uploadId);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) return snapshot.data().requestId === requestId;
    tx.set(ref, { requestId, createdAt: FieldValue.serverTimestamp() });
    return true;
  });
}
