// ABOUTME: UploadThing v7 signer — builds presigned ingest URLs locally from UPLOADTHING_TOKEN using only
// ABOUTME: node:crypto (no SDK). The extension PUTs bytes straight to UploadThing; be10x only stores keys.
import { randomUUID, createHmac } from 'node:crypto';
import Sqids from 'sqids';

// UPLOADTHING_TOKEN is base64-encoded JSON { apiKey, appId, regions } (UploadThing dashboard → API keys).
export function parseUploadThingToken(raw = process.env.UPLOADTHING_TOKEN) {
  if (!raw) throw new Error('MISSING_FIELD:UPLOADTHING_TOKEN');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new Error('MISSING_FIELD:UPLOADTHING_TOKEN');
  }
  if (!parsed || !parsed.apiKey || !parsed.appId) throw new Error('MISSING_FIELD:UPLOADTHING_TOKEN');
  return { apiKey: parsed.apiKey, appId: parsed.appId, regions: parsed.regions || ['sea1'] };
}

// Signs the full ingest URL (all params except `signature`) with HMAC-SHA256 keyed by the app's apiKey —
// the recipe UploadThing v7 uses so presigned URLs are generated on your own backend, no round-trip.
function signedUrl({ region, key, apiKey, params }) {
  const url = new URL(`https://${region}.ingest.uploadthing.com/${key}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const signature = 'hmac-sha256=' + createHmac('sha256', apiKey).update(url.toString()).digest('hex');
  url.searchParams.set('signature', signature);
  return url.toString();
}

// files: [{ name, size, type }]. opts.{token,now,makeKey,expiresInMs} are injectable for deterministic tests.
// UploadThing v7 file keys are `sqids(appId)` + base64url(seed) — NOT a random id. UploadThing's ingest
// validates that the sqids-encoded appId prefix matches the app, so a wrong key is rejected with
// "Invalid fileKey". This is the reference generateKey from UploadThing's docs (a djb2 hash + a sqids
// alphabet shuffled by the appId), ported verbatim so our keys match what their server expects.
const SQIDS_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function djb2(s) {
  let h = 5381;
  let i = s.length;
  while (i) h = (h * 33) ^ s.charCodeAt(--i);
  return (h & 0xbfffffff) | ((h >>> 1) & 0x40000000);
}

function shuffleAlphabet(str, seed) {
  const chars = str.split('');
  const seedNum = djb2(seed);
  for (let i = 0; i < chars.length; i++) {
    const j = ((seedNum % (i + 1)) + i) % chars.length;
    const t = chars[i];
    chars[i] = chars[j];
    chars[j] = t;
  }
  return chars.join('');
}

export function generateFileKey(appId, fileSeed) {
  const alphabet = shuffleAlphabet(SQIDS_ALPHABET, appId);
  const encodedAppId = new Sqids({ alphabet, minLength: 12 }).encode([Math.abs(djb2(appId))]);
  return encodedAppId + Buffer.from(String(fileSeed)).toString('base64url');
}

export function mintUploadUrls(files, opts = {}) {
  const { apiKey, appId, regions } = parseUploadThingToken(opts.token);
  const region = regions[0] || 'sea1';
  const now = opts.now ?? Date.now();
  const makeKey = opts.makeKey ?? (() => generateFileKey(appId, randomUUID()));
  const expiresInMs = opts.expiresInMs ?? 60 * 60 * 1000;
  return (files || []).map((f) => {
    const key = makeKey(f);
    const uploadUrl = signedUrl({
      region,
      key,
      apiKey,
      params: {
        expires: now + expiresInMs,
        'x-ut-identifier': appId,
        'x-ut-file-name': f.name,
        'x-ut-file-size': f.size,
        'x-ut-file-type': f.type || 'application/octet-stream',
      },
    });
    return { key, uploadUrl, fileUrl: `https://${appId}.ufs.sh/f/${key}`, name: f.name };
  });
}

// Builds a time-limited signed READ url for a PRIVATE UploadThing object, so the dashboard can hand the
// browser a short-lived link to a screenshot/DOM/network bundle without the bytes touching be10x. Same
// local-HMAC recipe as mintUploadUrls: sign the app-file URL (every param but `signature`) with
// HMAC-SHA256 keyed by the app's apiKey, and stamp an `expires`. opts.{token,now,expiresInMs} are
// injectable for deterministic tests; with no token it reads UPLOADTHING_TOKEN and throws
// MISSING_FIELD:UPLOADTHING_TOKEN when unset, like the mint path.
// NOTE: the exact UploadThing access-signing scheme (param names, host, or whether a REST call is
// required instead of local signing) must be confirmed live against a real UPLOADTHING_TOKEN before
// these read URLs are trusted in production.
export function signAccessUrl(key, opts = {}) {
  const { apiKey, appId } = parseUploadThingToken(opts.token);
  const now = opts.now ?? Date.now();
  const expiresInMs = opts.expiresInMs ?? 60 * 60 * 1000;
  const url = new URL(`https://${appId}.ufs.sh/f/${key}`);
  url.searchParams.set('expires', String(now + expiresInMs));
  const signature = 'hmac-sha256=' + createHmac('sha256', apiKey).update(url.toString()).digest('hex');
  url.searchParams.set('signature', signature);
  return url.toString();
}
