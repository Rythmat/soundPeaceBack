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

## Environment variables

| Variable | Example | Notes |
| -------- | ------- | ----- |
| `GCS_BUCKET` | `sound-bites` | Required. The bucket name, without `gs://`. |
| `ALLOWED_ORIGINS` | `https://sound-peace.onrender.com` | The frontend URL or URLs, comma-separated, with no trailing slash. Defaults to `http://localhost:5173`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/etc/secrets/service-account.json` | Path to the service account key. The service account needs `roles/storage.objectCreator` on the bucket. |
| `PORT` | `3000` | Render sets this itself. |

## Local development

```sh
cp .env.example .env   # set GCS_BUCKET; the key goes in ./service-account.json
npm install
npm run dev            # http://localhost:3000
```

`.env` and `service-account*.json` are gitignored. Check `git status` before your first commit to confirm that neither is staged.

## Deploy on Render (Web Service)

1. Push this folder to its own GitHub repo.
2. In Render, choose **New → Web Service** and pick the repo.
3. Use these settings:
   - **Runtime:** Node. `.node-version` pins Node 24.
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/healthz`
4. Under **Environment**:
   - Add a **Secret File** named `service-account.json` and paste the contents of your key into it.
   - Set `GCS_BUCKET` to `sound-bites`.
   - Set `GOOGLE_APPLICATION_CREDENTIALS` to `/etc/secrets/service-account.json`.
   - Set `ALLOWED_ORIGINS` to the frontend's Render URL. You'll know it once the frontend is created; until then, deploy without it and come back.

On the free plan, the service goes to sleep after a period with no traffic and takes up to about a minute to wake. The frontend pings `/healthz` as soon as someone opens it, so by the time they upload, the API is usually awake.
