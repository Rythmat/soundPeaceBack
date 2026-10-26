# A Sound Peace: backend

This is a small Express API. It receives voice clips from the [frontend](../frontend) and stores them in a Google Cloud Storage bucket. The Google credentials live only here, never in the browser.

## API

| Method | Path         | Description |
| ------ | ------------ | ----------- |
| GET    | `/healthz`   | Returns `{ ok: true }`. Used for Render's health check and the frontend's wake-up ping. |
| POST   | `/api/clips` | Takes a multipart form. `category` is `chaos` or `peace`, `deviceId` is the browser's random ID (a v4 UUID), and `audio` is one or more audio files of up to 2 MB each. Returns `201 { ids, record }`. Returns `409 { error, record }` if the upload would go over the device's limits. |

Clips are stored as `gs://$GCS_BUCKET/clips/<category>-<timestamp>-<uuid>.wav`.

## Per-device limits

Each browser creates a random, anonymous ID and sends it with every upload. Each device can upload at most **5 chaos clips** and **1 peace clip** in total. The record is kept in Firestore at `devices/<deviceId>` as `{ chaosUploads, harmonyUpload, updatedAt }`.

- The counts are checked and updated in a transaction before the clips are stored, so two uploads at the same moment can't both get past the limit. If storing fails, the reservation is given back so the participant can retry.
- Both `201` and `409` responses include the device's `record`, which the frontend saves as its local copy.
- The record holds only counts. The device ID is never written into clip names or metadata, so a participant's chaos and peace clips can't be linked.
- Clearing site data resets the ID. This stops casual repeat uploads, not someone determined to get around it.

There are deliberately no routes to list or download clips. The installation should read the bucket with its own read-only credentials.

Browser requests are accepted only from origins listed in `ALLOWED_ORIGINS`. Requests from any other origin get a `403`.