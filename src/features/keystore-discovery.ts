// Enumerates Foundry keystores at ~/.foundry/keystores/ (names and addresses
// only). The extension never reads passwords or decrypts keystores: signing
// with these accounts happens in Foundry itself (`forge script --account`).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface KeystoreEntry {
  name: string; // filename in ~/.foundry/keystores/
  address: string; // 0x-prefixed checksum-agnostic
  path: string; // absolute path of the keystore file
}

interface KeystoreV3 {
  version: number | string;
  address?: string;
  /** Some old keystores (geth) use this capitalisation. */
  Address?: string;
  /** Some encoders nest the address under `id`/`meta` — we probe broadly. */
  id?: string;
  crypto?: { ciphertext?: string };
  Crypto?: { ciphertext?: string };
}

function isV3(obj: unknown): obj is KeystoreV3 {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const o = obj as Record<string, unknown>;
  // Accept "version: 3" and "version: '3'" — both are seen in the wild.
  const v = o.version;
  if (v !== 3 && v !== '3') {
    return false;
  }
  // Either `crypto` (modern) or `Crypto` (legacy geth) with a ciphertext.
  const crypto =
    (o.crypto as Record<string, unknown> | undefined) ??
    (o.Crypto as Record<string, unknown> | undefined);
  return !!crypto && typeof crypto.ciphertext === 'string';
}

/**
 * Extract the address from a v3 keystore, tolerating the various places where
 * different encoders stash it. Returns an empty string if none can be found —
 * which is unusual but happens for keystores created without explicit address
 * metadata (the address is then only recoverable by decrypting).
 */
function extractAddress(parsed: KeystoreV3, filename: string): string {
  const candidates: Array<string | undefined> = [
    parsed.address,
    parsed.Address,
    // geth-style filenames embed the address: "UTC--2024-01-01T00-00-00.000Z--<address>"
    filename.split('--').pop(),
  ];
  for (const c of candidates) {
    if (typeof c !== 'string') {
      continue;
    }
    const trimmed = c.trim().replace(/^0x/i, '');
    if (/^[0-9a-fA-F]{40}$/.test(trimmed)) {
      return '0x' + trimmed.toLowerCase();
    }
  }
  return '';
}

export function getDefaultKeystoreDir(): string {
  // Allow override for testing / non-standard installs
  return process.env.FOUNDRY_KEYSTORES_DIR ?? path.join(os.homedir(), '.foundry', 'keystores');
}

export function listKeystores(dir: string = getDefaultKeystoreDir()): KeystoreEntry[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: KeystoreEntry[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    if (!isV3(parsed)) {
      continue;
    }
    const address = extractAddress(parsed, name);
    // Empty `address` is fine here — some keystores (e.g. ethers-encrypted ones
    // without explicit metadata) don't ship one in the JSON, and we never
    // decrypt, so the address simply stays unknown in the UI.
    out.push({ name, address, path: full });
  }
  return out;
}
