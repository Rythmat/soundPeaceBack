import { FieldValue } from '@google-cloud/firestore';

// How many clips each device may upload in total, per category. These match the
// frontend: five chaos clips and one peace (harmony) clip.
export const CLIP_LIMITS = { chaos: 5, peace: 1 };

// The frontend generates device and upload IDs with crypto.randomUUID(), which produces
// v4 UUIDs.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Thrown when an upload would go over the device's limits. Carries the current record
// so the frontend can bring its local copy up to date.
export class LimitError extends Error {
  constructor(message, record) {
    super(message);
    this.record = record;
  }
}

// One Firestore document per device: devices/<deviceId>. It holds the counts and, for
// each upload counted, its upload ID mapped to the request that counted it. Neither
// ever appears in clip names, so a participant's chaos and peace clips can't be linked.
function parse(data = {}) {
  return {
    record: {
      chaosUploads: data.chaosUploads ?? 0,
      harmonyUpload: data.harmonyUpload ?? false,
    },
    uploads: data.uploads ?? {},
  };
}

// The record with `count` more clips counted. Throws LimitError if that would go over
// the device's limits.
function withUploads(record, category, count) {
  if (category === 'chaos') {
    const remaining = CLIP_LIMITS.chaos - record.chaosUploads;
    if (count > remaining) {
      const message =
        remaining === 0
          ? 'This device has already uploaded all of its chaos clips.'
          : `This device can upload ${remaining} more chaos clip${remaining === 1 ? '' : 's'}.`;
      throw new LimitError(message, record);
    }
    return { ...record, chaosUploads: record.chaosUploads + count };
  }
  if (record.harmonyUpload) {
    throw new LimitError('This device has already uploaded its peace clip.', record);
  }
  return { ...record, harmonyUpload: true };
}

// Returns { record, uploads } for a device, read outside any transaction. Good enough
// to turn away uploads before storing them; countUploads makes the binding decision.
export async function readDevice(db, deviceId) {
  return parse((await db.collection('devices').doc(deviceId).get()).data());
}

// Throws LimitError if the device can't upload `count` more clips.
export function checkAllowance(record, category, count) {
  withUploads(record, category, count);
}

// Atomically counts an upload whose clips are already stored, so two uploads at the same
// moment can't both slip past the limits. `uploadId` stays the same when the browser
// retries; `requestId` is unique to this request. Returns { record, counted }, where
// counted is false if another request already counted this upload (its clips are
// stored, so this request's copies are spare). Firestore can run this more than once
// for one request when a commit's outcome is unclear, so a match on requestId means an
// earlier run of this same request committed: the upload is counted, by this request.
export function countUploads(db, { deviceId, category, count, uploadId, requestId }) {
  const ref = db.collection('devices').doc(deviceId);
  return db.runTransaction(async (tx) => {
    const { record, uploads } = parse((await tx.get(ref)).data());
    if (uploads[uploadId]) return { record, counted: uploads[uploadId] === requestId };
    const updated = withUploads(record, category, count);
    tx.set(
      ref,
      { ...updated, uploads: { [uploadId]: requestId }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { record: updated, counted: true };
  });
}
