# A Sound Peace: backend

This is a small Express API. It receives voice clips from the [frontend](../frontend) and stores them in a Google Cloud Storage bucket. The Google credentials live only here, never in the browser.

## API

| Method | Path         | Description |
| ------ | ------------ | ----------- |
| GET    | `/healthz`   | Returns `{ ok: true }`. Used for Render's health check and the frontend's wake-up ping. |
| POST   | `/api/clips` | Takes a multipart form. `category` is `chaos` or `peace`, `deviceId` is the browser's random ID (a v4 UUID), `uploadId` is a v4 UUID that stays the same when the browser retries the same clips (optional), and `audio` is one or more audio files of up to 4 MB each. Returns `201 { ids, record }`. Returns `200 { ids: [], record }` if this `uploadId` was already stored and counted. Returns `409 { error, record }` if the upload would go over the device's limits. |

Clips are stored as `gs://$GCS_BUCKET/clips/<category>-<timestamp>-<uuid>.wav`.

## Per-device limits

Each browser creates a random, anonymous ID and sends it with every upload. Each device can upload at most **5 chaos clips** and **1 peace clip** in total. The record is kept in Firestore at `devices/<deviceId>` as `{ chaosUploads, harmonyUpload, uploads, updatedAt }`, where `uploads` maps each counted `uploadId` to the request that counted it.

- The limits are checked before anything is stored. The clips are stored next, and only then counted, in a transaction, so two uploads at the same moment can't both get past the limit. If the transaction refuses the upload, the clips just stored are deleted again.
- Storing comes first so that nothing can be counted without being stored. If the server dies between the two steps, the clips are stored but not counted, and the participant's retry stores them again. That leaves a spare copy in the bucket rather than a lost clip.
- A retry of an upload that went through, whose response never reached the browser, carries the same `uploadId`. The server answers it without storing the clips again.
- If only some clips in a batch are stored, the stored ones are deleted, because the participant will retry the whole batch. Deleting needs `storage.objects.delete`; without it, the server logs the failure and the spare copies stay.
- `201`, `200` and `409` responses all include the device's `record`, which the frontend saves as its local copy.
- The record holds only counts and upload IDs. Neither the device ID nor the upload ID is ever written into clip names or metadata, so a participant's chaos and peace clips can't be linked.
- Clearing site data resets the ID. This stops casual repeat uploads, not someone determined to get around it.

## Reliability

- **Startup check:** before it takes requests, the server confirms its credentials can create objects in the bucket and read Firestore. If either fails, it exits, so a bad configuration fails the deploy instead of every upload. If it can't delete objects, it starts anyway and logs a warning.
- **Retries:** every Storage call is retried on transient errors. Uploads are made with `ifGenerationMatch: 0`, so a retry can never overwrite anything. If a retry finds that its earlier attempt already went through, it counts as stored.
- **Shutdown:** on `SIGTERM`, which Render sends before a deploy or restart replaces the instance, the server stops accepting connections and lets requests in progress finish before exiting.

There are deliberately no routes to list or download clips. The installation should read the bucket with its own read-only credentials.

Browser requests are accepted only from origins listed in `ALLOWED_ORIGINS`. Requests from any other origin get a `403`.