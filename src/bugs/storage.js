// ABOUTME: Bug-artifact storage seam. Replaces UploadThing: the extension PUTs capture bytes (screenshot,
// ABOUTME: DOM, network, rrweb session) to the board, which stores them on local disk and serves them back
// ABOUTME: via short-lived signed /api/blob/:key URLs. Driver selected by BUG_STORAGE (local | s3-stub).
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// --- signing ---------------------------------------------------------------
// A blob URL carries ?exp=<ms>&sig=<hex>; the signature binds the HTTP method + key + expiry, so a read
// grant can't be replayed as a write and vice-versa. HMAC-SHA256 keyed by the board's per-store secret.
export function signBlobUrl(secret, method, key, exp) {
  return createHmac('sha256', secret).update(`${method}:${key}:${exp}`).digest('hex');
}

export function verifyBlobSig(secret, method, key, exp, sig, { now = Date.now() } = {}) {
  if (!sig || Number(exp) < now) return false;
  const expected = signBlobUrl(secret, method, key, exp);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- multipart ------------------------------------------------------------
// The (unchanged) capture extension PUTs a multipart/form-data body with a single `file` part. Pull that
// part's raw bytes + declared content-type back out — a minimal single-part reader, binary-safe.
export function extractFilePart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('BAD_MULTIPART:no-boundary');
  const boundary = '--' + (m[1] || m[2]).trim();
  const start = buffer.indexOf(boundary);
  if (start === -1) throw new Error('BAD_MULTIPART:no-part');
  const headerStart = start + boundary.length + 2; // skip boundary + CRLF
  const headerEnd = buffer.indexOf('\r\n\r\n', headerStart);
  if (headerEnd === -1) throw new Error('BAD_MULTIPART:no-headers');
  const headers = buffer.slice(headerStart, headerEnd).toString('utf8');
  const bodyStart = headerEnd + 4;
  const bodyEnd = buffer.indexOf('\r\n' + boundary, bodyStart); // closing boundary
  if (bodyEnd === -1) throw new Error('BAD_MULTIPART:unterminated');
  const ct = /content-type:\s*([^\r\n]+)/i.exec(headers);
  const fn = /filename="([^"]*)"/i.exec(headers);
  return {
    bytes: buffer.slice(bodyStart, bodyEnd),
    contentType: ct ? ct[1].trim() : 'application/octet-stream',
    filename: fn ? fn[1] : null,
  };
}

// --- local (on-disk) driver -----------------------------------------------
const KEY_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function makeLocalStorage({ dir, secret, baseUrl, now = () => Date.now(), expiresInMs = DEFAULT_TTL_MS }) {
  // Secret may be a value or a lazy thunk — resolved (and memoized) only when a blob is actually signed or
  // verified, so merely constructing the app (as most tests do) touches no disk and generates no secret.
  let cached;
  const getSecret = () => (cached ??= typeof secret === 'function' ? secret() : secret);
  const safe = (key) => {
    if (!key || !KEY_RE.test(key)) throw new Error('BAD_KEY');
    return join(dir, key);
  };
  const url = (method, key, base) => {
    const exp = now() + expiresInMs;
    const sig = signBlobUrl(getSecret(), method, key, exp);
    return `${(base || baseUrl).replace(/\/$/, '')}/api/blob/${key}?exp=${exp}&sig=${sig}`;
  };
  return {
    driver: 'local',
    presignUpload(files, opts = {}) {
      const makeKey = opts.makeKey || (() => randomUUID());
      return (files || []).map((f) => {
        const key = makeKey(f);
        return { key, name: f.name, uploadUrl: url('PUT', key, opts.baseUrl), fileUrl: `${(opts.baseUrl || baseUrl).replace(/\/$/, '')}/api/blob/${key}` };
      });
    },
    write(key, bytes, contentType) {
      const p = safe(key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, bytes);
      if (contentType) writeFileSync(p + '.ct', contentType);
    },
    read(key) {
      return readFileSync(safe(key));
    },
    contentType(key) {
      const p = safe(key) + '.ct';
      return existsSync(p) ? readFileSync(p, 'utf8') : 'application/octet-stream';
    },
    signReadUrl(key, opts = {}) {
      return url('GET', key, opts.baseUrl);
    },
    verify(method, key, exp, sig) {
      return verifyBlobSig(getSecret(), method, key, exp, sig, { now: now() });
    },
  };
}

// --- s3 seam (stub) --------------------------------------------------------
// Declared so the swap to object storage is one file: implement these against a presigned-URL S3 client
// and flip BUG_STORAGE=s3. Until then every call is a loud NOT_IMPLEMENTED rather than a silent no-op.
function makeS3Storage(_env) {
  const nope = () => { throw new Error('NOT_IMPLEMENTED:s3 storage driver — implement src/bugs/storage.js makeS3Storage'); };
  return { driver: 's3', presignUpload: nope, write: nope, read: nope, contentType: nope, signReadUrl: nope, verify: nope };
}

// --- selection + secret ----------------------------------------------------
// The signing secret is per-store: prefer GFA_BLOB_SECRET, else a persisted `.secret` in the blob dir
// (generated once) so signed URLs survive restarts without any external config.
function secretFor(dir, env) {
  if (env.GFA_BLOB_SECRET) return env.GFA_BLOB_SECRET;
  mkdirSync(dir, { recursive: true });
  const p = join(dir, '.secret');
  if (existsSync(p)) return readFileSync(p, 'utf8');
  const s = randomUUID() + randomUUID();
  writeFileSync(p, s, { mode: 0o600 });
  return s;
}

export function getStorage(env = process.env) {
  const driver = env.BUG_STORAGE || 'local';
  if (driver === 's3') return makeS3Storage(env);
  if (driver !== 'local') throw new Error('UNKNOWN_BUG_STORAGE:' + driver);
  const dir = env.GFA_BLOB_DIR || './blobs';
  const baseUrl = env.GFA_BLOB_BASE_URL || `http://127.0.0.1:${env.PORT || 4610}`;
  // Lazy secret: only resolved (and only then persisted) when a blob is first signed/verified.
  return makeLocalStorage({ dir, secret: () => secretFor(dir, env), baseUrl });
}
