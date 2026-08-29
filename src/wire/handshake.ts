/**
 * The 68-byte BitTorrent handshake.
 *
 * Ported from cf-stream. It was already pure Web API — `crypto.getRandomValues` and typed arrays —
 * so nothing about it is runtime-specific.
 *
 * Plaintext, with no MSE/PE obfuscation layer. That is a measured decision, not an omission:
 * dialling the live swarm for the sample torrent completed 8 handshakes out of 8 in the clear,
 * every peer advertising the extension protocol. Encryption is *preferred* by qBittorrent and
 * off by default in µTorrent, so requiring it is the unusual case.
 *
 * Three reserved bits are advertised, and the peer's own are kept so the caller can see what it
 * supports.
 */

import { bytesEqual, encoder } from "../bytes.ts";
import { WireConn, WireError } from "./conn.ts";

const PROTOCOL = encoder.encode("BitTorrent protocol");
const HANDSHAKE_BYTES = 68;

/** BEP-10 extension protocol. */
const RESERVED_EXTENDED_BYTE = 5;
const RESERVED_EXTENDED_BIT = 0x10;
/** BEP-6 fast extension and BEP-5 DHT share reserved byte 7. */
const RESERVED_LAST_BYTE = 7;
const RESERVED_FAST_BIT = 0x04;
const RESERVED_DHT_BIT = 0x01;

export interface HandshakeResult {
  readonly peerId: Uint8Array;
  readonly supportsExtended: boolean;
  /**
   * BEP-6. Worth having: it guarantees every `request` yields exactly one response — the piece,
   * or an explicit `reject` — which turns stalled-request detection from a timeout heuristic into
   * a deterministic signal, and so decides how fast a useless peer is replaced.
   */
  readonly supportsFast: boolean;
  readonly supportsDht: boolean;
}

export function generatePeerId(): Uint8Array {
  // Azureus-style client id, then 12 random printable bytes, for exactly 20.
  const prefix = encoder.encode("-CL0001-");
  const out = new Uint8Array(20);
  out.set(prefix, 0);
  const random = crypto.getRandomValues(new Uint8Array(12));
  for (let i = 0; i < 12; i++) out[8 + i] = 0x30 + (random[i]! % 62);
  return out;
}

export function buildHandshake(infoHash: Uint8Array, peerId: Uint8Array): Uint8Array {
  if (infoHash.length !== 20) throw new WireError("infohash must be 20 bytes");
  if (peerId.length !== 20) throw new WireError("peer id must be 20 bytes");
  const out = new Uint8Array(HANDSHAKE_BYTES);
  out[0] = PROTOCOL.length;
  out.set(PROTOCOL, 1);
  out[20 + RESERVED_EXTENDED_BYTE] = RESERVED_EXTENDED_BIT;
  // Fast and DHT share byte 7, so this one has to be an or of both bits rather than an assignment.
  // The DHT bit is advertised but not acted on: a Worker has no UDP, so peer discovery happens
  // out of band and this only tells the peer we would accept its `port` message.
  out[20 + RESERVED_LAST_BYTE] = RESERVED_FAST_BIT | RESERVED_DHT_BIT;
  out.set(infoHash, 28);
  out.set(peerId, 48);
  return out;
}

export async function performHandshake(
  conn: WireConn,
  infoHash: Uint8Array,
  peerId: Uint8Array,
): Promise<HandshakeResult> {
  await conn.write(buildHandshake(infoHash, peerId));
  const response = await conn.readExact(HANDSHAKE_BYTES);

  if (response[0] !== PROTOCOL.length || !bytesEqual(response.subarray(1, 20), PROTOCOL)) {
    throw new WireError("peer did not speak the BitTorrent protocol");
  }
  if (!bytesEqual(response.subarray(28, 48), infoHash)) {
    // A peer serving a different torrent on this port. Nothing it says is relevant to us.
    throw new WireError("peer returned a different infohash");
  }

  const reserved = response.subarray(20, 28);
  return {
    peerId: response.subarray(48, 68),
    supportsExtended: (reserved[RESERVED_EXTENDED_BYTE]! & RESERVED_EXTENDED_BIT) !== 0,
    supportsFast: (reserved[RESERVED_LAST_BYTE]! & RESERVED_FAST_BIT) !== 0,
    supportsDht: (reserved[RESERVED_LAST_BYTE]! & RESERVED_DHT_BIT) !== 0,
  };
}
