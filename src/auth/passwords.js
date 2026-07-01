// ABOUTME: Password hashing and verification using scrypt (node:crypto).
// ABOUTME: Stored format is `scrypt$<saltHex>$<hashHex>`; verification is constant-time.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
