/** Shared helpers for consumer API keys. Never logs or returns raw keys. */

export const KEY_NAMESPACE = "oxs";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomBase62(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/** Returns the one-time raw key plus the stored prefix/hash pair. */
export async function mintConsumerKey() {
  const prefixPart = randomBase62(8);
  const secretPart = randomBase62(40);
  const rawKey = `${KEY_NAMESPACE}_${prefixPart}_${secretPart}`;
  return {
    rawKey,
    keyPrefix: `${KEY_NAMESPACE}_${prefixPart}`,
    keyHash: await sha256Hex(rawKey),
  };
}

/** Extracts the stored prefix from a presented raw key, or null when malformed. */
export function prefixFromRawKey(rawKey: string): string | null {
  const parts = rawKey.split("_");
  if (parts.length !== 3) return null;
  if (parts[0] !== KEY_NAMESPACE) return null;
  if (!parts[1] || !parts[2]) return null;
  return `${parts[0]}_${parts[1]}`;
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function encodeCursor(updatedAt: string, id: string): string {
  return btoa(`${updatedAt}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(normalized);
    const sep = decoded.lastIndexOf("|");
    if (sep < 1) return null;
    const updatedAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!updatedAt || !id) return null;
    if (Number.isNaN(Date.parse(updatedAt))) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}
