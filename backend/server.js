const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const port = Number(process.env.PORT || 10000);
const uploadTtl = Number(process.env.UPLOAD_URL_TTL_SECONDS || 900);
const downloadTtl = Number(process.env.DOWNLOAD_URL_TTL_SECONDS || 86400);
const maxFileSize = Number(process.env.MAX_FILE_SIZE_BYTES || 50 * 1024 ** 3);
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",").map((origin) => origin.trim()).filter(Boolean);

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
}));
app.use(express.json({ limit: "32kb" }));

let s3;
function storageConfigured() {
  return Boolean(process.env.STORAGE_ENDPOINT && process.env.STORAGE_ACCESS_KEY_ID &&
    process.env.STORAGE_SECRET_ACCESS_KEY && process.env.BUCKET_NAME);
}
function getS3() {
  if (!storageConfigured()) throw new Error("Object storage is not configured");
  if (!s3) {
    s3 = new S3Client({
      region: "auto",
      endpoint: process.env.STORAGE_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY
      }
    });
  }
  return s3;
}
function safeFilename(name) {
  const cleaned = String(name || "file").normalize("NFKC")
    .replace(/[\/\\]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim().slice(0, 180);
  return cleaned || "file";
}
function makeObjectKey(filename) {
  // Keep only the final file extension in the opaque storage key.
  const ext = path.extname(filename).slice(1).toLowerCase()
    .replace(/[^a-z0-9]/g, "").slice(0, 12);
  return \`uploads/\${new Date().toISOString().slice(0, 10)}/\${crypto.randomUUID()}\${ext ? "." + ext : ""}\`;
}
function contentDisposition(filename) {
  // RFC 5987 filename* preserves Unicode; filename provides an ASCII fallback.
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return \`attachment; filename="\${fallback}"; filename*=UTF-8''\${encodeURIComponent(filename)}\`;
}
function validateFilePayload(body) {
  const filename = safeFilename(body?.filename);
  const size = Number(body?.size);
  const contentType = String(body?.contentType || "application/octet-stream").slice(0, 200);
  if (!Number.isFinite(size) || size <= 0 || size > maxFileSize) {
    const err = new Error(`File size must be between 1 byte and ${maxFileSize} bytes`);
    err.status = 400; throw err;
  }
  return { filename, size, contentType };
}

app.get("/health", (_req, res) => res.status(200).json({
  status: "ok",
  service: "nexo-lab-storage-api",
  storageConfigured: storageConfigured()
}));

app.post("/api/upload-url", async (req, res, next) => {
  try {
    const { filename, size, contentType } = validateFilePayload(req.body);
    const key = makeObjectKey(filename);
    const command = new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      Metadata: { originalname: encodeURIComponent(filename), filesize: String(size) }
    });
    const uploadUrl = await getSignedUrl(getS3(), command, { expiresIn: uploadTtl });
    res.json({ uploadUrl, key, filename, expiresIn: uploadTtl });
  } catch (err) { next(err); }
});

app.post("/api/download-url", async (req, res, next) => {
  try {
    if (!storageConfigured()) return res.status(503).json({ error: "Object storage is not configured" });
    const key = String(req.body?.key || "");
    const filename = safeFilename(req.body?.filename || "download");
    if (!key.startsWith("uploads/") || key.length > 1024 || key.includes("..")) {
      return res.status(400).json({ error: "Invalid object key" });
    }
    const command = new GetObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
      ResponseContentDisposition: contentDisposition(filename)
    });
    const downloadUrl = await getSignedUrl(getS3(), command, { expiresIn: downloadTtl });
    res.json({ downloadUrl, expiresIn: downloadTtl });
  } catch (err) { next(err); }
});

app.use((err, _req, res, _next) => {
  if (err.message === "Object storage is not configured") {
    return res.status(503).json({ error: err.message });
  }
  if (err.message === "Origin not allowed by CORS") return res.status(403).json({ error: err.message });
  const status = Number(err.status) || 500;
  if (status >= 500) console.error("API error:", err.message);
  res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
});

app.listen(port, "0.0.0.0", () => console.log(`Nexo Lab Storage API listening on ${port}`));
