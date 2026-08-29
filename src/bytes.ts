/**
 * Byte helpers, ported from cf-stream.
 *
 * Everything here is standard Web API — `TextDecoder`, typed arrays — so it runs identically in
 * Deno and in workerd.
 *
 * `sha1` is deliberately **absent**. The predecessor hashed every piece before storing it, which
 * cost 300-600 ms of CPU per 276 MB video and was the single largest item in its budget. Here the
 * browser verifies, so the Worker never hashes anything and never needs to.
 */

export const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex string (${hex.length})`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`"${hex}" is not hex`);
    out[i] = byte;
  }
  return out;
}

/** Constant in the lengths, not in the contents — these are hashes and infohashes, not secrets. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
