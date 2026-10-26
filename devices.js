import { FieldValue } from '@google-cloud/firestore';

// How many clips each device may upload in total, per category. These match the
// frontend: five chaos clips and one peace (harmony) clip.
export const CLIP_LIMITS = { chaos: 5, peace: 1 };

// The frontend generates IDs with crypto.randomUUID(), which produces v4 UUIDs.
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isDeviceId(value) {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

// Thrown when an upload would go over the device's limits. Carries the current record
// so the frontend can bring its local copy up to date.
export class LimitError extends Error {
  constructor(message, record) {
    super(message);
    this.record = record;
  }
}

// One Firestore document per device: devices/<deviceId>. It holds only the counts,
// never clip names, so a participant's chaos and peace clips can't be linked.
function toRecord(data = {}) {
  return {
    chaosUploads: data.chaosUploads ?? 0,
    harmonyUpload: data.harmonyUpload ?? false,
  };
}

function updateRecord(db, deviceId, change) {
  const ref = db.collection('devices').doc(deviceId);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const record = change(toRecord(snapshot.data()));
    tx.set(ref, { ...record, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return record;
  });
}

// Atomically checks the limits and counts `count` clips against them, so two uploads
// at the same moment can't both slip past. Returns the updated record.
export function reserveUploads(db, deviceId, category, count) {
  return updateRecord(db, deviceId, (record) => {
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
  });
}

// Undoes reserveUploads when storing the clips fails, so the participant can retry.
export function releaseUploads(db, deviceId, category, count) {
  return updateRecord(db, deviceId, (record) =>
    category === 'chaos'
      ? { ...record, chaosUploads: Math.max(0, record.chaosUploads - count) }
      : { ...record, harmonyUpload: false },
  );
}
