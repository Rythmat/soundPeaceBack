# A Sound Peace: backend

This is a small Express API. It receives voice clips from the [frontend](../frontend) and stores them in a Google Cloud Storage bucket. The Google credentials live only here, never in the browser.

## API

| Method | Path         | Description |
| ------ | ------------ | ----------- |
| GET    | `/healthz`   | Returns `{ ok: true }`. Used for Render's health check and the frontend's wake-up ping. |
| POST   | `/api/clips` | Takes a multipart form. `category` is `chaos` or `peace`, `uploadId` is a v4 UUID that stays the same when the browser retries the same clips (optional), and `audio` is the audio files: up to 5 chaos clips or 1 peace clip, of up to 4 MB each. Returns `201 { ids }`. Returns `200 { ids: [] }` if this `uploadId` was already stored. |

Clips are stored as `gs://$GCS_BUCKET/clips/<category>-<timestamp>-<uuid>.wav`.

## Uploads

There is no limit on how many times someone can upload. Each upload carries what one visit to a page can record (up to 5 chaos clips, or 1 peace clip), and the same person can come back and upload again. Uploads aren't tied to a device or a person.

Each stored upload is recorded in Firestore at `uploads/<uploadId>` as `{ requestId, createdAt }`. The record exists only so that retries don't create duplicates:

- The clips are stored first, and the upload is recorded only after that. If the server dies between the two steps, the clips are stored but not recorded, and the participant's retry stores them again. That leaves a spare copy in the bucket rather than a lost clip.
- A retry of an upload that went through, whose response never reached the browser, carries the same `uploadId`. The server answers it without storing the clips again. If two requests for the same upload arrive at once, the second to finish deletes its own copies.
- If only some clips in a batch are stored, the stored ones are deleted, because the participant will retry the whole batch. Deleting needs `storage.objects.delete`; without it, the server logs the failure and the spare copies stay.

## Reliability

- **Startup check:** before it takes requests, the server confirms its credentials can create objects in the bucket and read Firestore. If either fails, it exits, so a bad configuration fails the deploy instead of every upload. If it can't delete objects, it starts anyway and logs a warning.
- **Retries:** every Storage call is retried on transient errors. Uploads are made with `ifGenerationMatch: 0`, so a retry can never overwrite anything. If a retry finds that its earlier attempt already went through, it counts as stored.
- **Shutdown:** on `SIGTERM`, which Render sends before a deploy or restart replaces the instance, the server stops accepting connections and lets requests in progress finish before exiting.

There are deliberately no routes to list or download clips. The installation should read the bucket with its own read-only credentials.

Browser requests are accepted only from origins listed in `ALLOWED_ORIGINS`. Requests from any other origin get a `403`.