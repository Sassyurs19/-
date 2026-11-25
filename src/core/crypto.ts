// src/core/crypto.ts
// AES-256-GCM encryption for session directories
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;
const ENC_EXT = '.enc';

function getKey(): Buffer {
  const hex = config.encryptionKey;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptFile(plainPath: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const plaintext = fs.readFileSync(plainPath);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encPath = plainPath + ENC_EXT;
  // Format: iv(16) + tag(16) + ciphertext; restrict file mode to owner read/write
  fs.writeFileSync(encPath, Buffer.concat([iv, tag, encrypted]), { mode: 0o600 });
  fs.unlinkSync(plainPath);
  return encPath;
}

export function decryptFile(encPath: string): string {
  if (!encPath.endsWith(ENC_EXT)) {
    throw new Error(`Expected encrypted file ending with ${ENC_EXT}`);
  }
  const key = getKey();
  const data = fs.readFileSync(encPath);
  if (data.length < IV_LEN + TAG_LEN) {
    throw new Error('Encrypted session file is corrupted or truncated');
  }
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const plainPath = encPath.slice(0, -ENC_EXT.length);
  fs.writeFileSync(plainPath, decrypted, { mode: 0o600 });
  return plainPath;
}

export function encryptDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    if (file.startsWith('.baw_no_keytar')) continue;
    const full = path.join(dirPath, file);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile() && !file.endsWith(ENC_EXT)) {
      encryptFile(full);
    } else if (stat.isDirectory()) {
      encryptDir(full);
    }
  }
}

export function decryptDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const full = path.join(dirPath, file);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile() && file.endsWith(ENC_EXT)) {
      decryptFile(full);
    } else if (stat.isDirectory()) {
      decryptDir(full);
    }
  }
}

export function wipeDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * Startup security sweep: encrypt any leftover plaintext session files from an
 * unexpected crash and remove orphaned temp connect directories older than 10 minutes.
 */
export function sweepSessionsDir(sessionsRoot: string, maxTempAgeMs = 10 * 60_000): number {
  if (!fs.existsSync(sessionsRoot)) return 0;
  let swept = 0;
  const now = Date.now();
  for (const entry of fs.readdirSync(sessionsRoot)) {
    if (entry.startsWith('.baw_no_keytar')) continue;
    const full = path.join(sessionsRoot, entry);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;

    if (entry.includes('_new_') && now - stat.mtimeMs > maxTempAgeMs) {
      wipeDir(full);
      swept++;
      continue;
    }

    // Re-encrypt any plaintext leftovers safely
    const inner = fs.readdirSync(full);
    const hasPlaintext = inner.some((f) => !f.endsWith(ENC_EXT) && !f.startsWith('.baw_no_keytar'));
    if (hasPlaintext) {
      encryptDir(full);
      swept++;
    }
  }
  return swept;
}
