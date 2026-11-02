# Nexo Lab Storage

Original-quality multimedia storage and transfer for creators.

## Architecture
- Static frontend: `/frontend` (Netlify)
- API: `/backend` (Node.js/Express on Render)
- Object storage: Cloudflare R2 (S3-compatible); browser uploads/downloads directly using presigned URLs.

## Deployment
### Render API
Create a Node web service connected to this repository:
- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node
- Configure `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `BUCKET_NAME`, and `FRONTEND_ORIGIN`.

### Netlify frontend
- Base directory: `frontend`
- Build command: empty
- Publish directory: `.`
- Set `NEXO_API_BASE_URL` in `frontend/config.js` to the Render service URL (static-site config is committed as a JS file).

## Security and behavior
- Files are uploaded directly from the browser to R2; the API never proxies file bytes.
- Presigned upload URLs expire after 15 minutes.
- Download links expire after 24 hours.
- CORS must be configured on the R2 bucket for the deployed frontend origin, allowing GET, PUT, HEAD and the required headers.
- The MVP creates a unique object key per upload. Link possession grants access until expiry; there is no account system or revocation layer yet.
