# A Sound Peace: backend

This is a small Express API. It receives voice clips from the [frontend](../frontend) and stores them in a Google Cloud Storage bucket. The Google credentials live only here, never in the browser.

## API

| Method | Path         | Description |
| ------ | ------------ | ----------- |
| GET    | `/healthz`   | Returns `{ ok: true }`. Used for Render's health check and the frontend's wake-up ping. |
| POST   | `/api/clips` | Takes a multipart form. `category` is `chaos` (1–5 clips) or `peace` (exactly 1 clip). `audio` is one or more audio files of up to 2 MB each. Returns `201 { ids: [...] }`. |

Clips are stored as `gs://$GCS_BUCKET/clips/<category>-<timestamp>-<uuid>.wav`.

There are deliberately no routes to list or download clips. The installation should read the bucket with its own read-only credentials.

Browser requests are accepted only from origins listed in `ALLOWED_ORIGINS`. Requests from any other origin get a `403`.
