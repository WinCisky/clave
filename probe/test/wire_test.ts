import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  Bitfield,
  buildHandshake,
  frame,
  FramedConn,
  generatePeerId,
  interestedFrame,
  MSG_BITFIELD,
  MSG_KEEPALIVE,
  parseHandshakeResponse,
  parseHave,
  readMessage,
  WireError,
} from "../wire.ts";

const INFO_HASH = new Uint8Array(20).map((_, i) => i);
const OTHER_HASH = new Uint8Array(20).map((_, i) => i + 1);

Deno.test("buildHandshake produces a 68-byte plaintext handshake round-trippable by parseHandshakeResponse", () => {
  const peerId = generatePeerId();
  const handshake = buildHandshake(INFO_HASH, peerId);
  assertEquals(handshake.length, 68);
  assertEquals(handshake[0], 19); // "BitTorrent protocol".length

  const result = parseHandshakeResponse(handshake, INFO_HASH);
  assert(result.supportsExtended);
  assert(result.supportsFast);
  assert(result.supportsDht);
});

Deno.test("parseHandshakeResponse rejects a mismatched infohash", () => {
  const handshake = buildHandshake(INFO_HASH, generatePeerId());
  assertThrows(() => parseHandshakeResponse(handshake, OTHER_HASH), WireError, "infohash");
});

Deno.test("parseHandshakeResponse rejects a non-BitTorrent protocol string", () => {
  const handshake = buildHandshake(INFO_HASH, generatePeerId());
  const corrupted = new Uint8Array(handshake);
  corrupted[0] = 5;
  assertThrows(() => parseHandshakeResponse(corrupted, INFO_HASH), WireError, "protocol");
});

Deno.test("buildHandshake rejects a wrong-length infohash or peer id", () => {
  assertThrows(() => buildHandshake(new Uint8Array(19), generatePeerId()), WireError);
  assertThrows(() => buildHandshake(INFO_HASH, new Uint8Array(19)), WireError);
});

Deno.test("Bitfield big-endian bit order: the high bit of byte 0 is piece 0", () => {
  const field = Bitfield.fromPayload(new Uint8Array([0b1000_0001]), 8);
  assert(field.has(0));
  assert(field.has(7));
  assert(!field.has(1));
  assertEquals(field.count, 2);
});

Deno.test("Bitfield.full marks every piece up to pieceCount", () => {
  const field = Bitfield.full(10);
  for (let i = 0; i < 10; i++) assert(field.has(i));
  assertEquals(field.count, 10);
});

Deno.test("Bitfield.fromPayload rejects a payload shorter than pieceCount requires", () => {
  assertThrows(() => Bitfield.fromPayload(new Uint8Array(1), 100), WireError);
});

Deno.test("frame() writes a big-endian length prefix covering id + payload", () => {
  const payload = new Uint8Array([9, 9]);
  const framed = frame(7, payload);
  const view = new DataView(framed.buffer);
  assertEquals(view.getUint32(0), 1 + payload.length);
  assertEquals(framed[4], 7);
  assertEquals([...framed.subarray(5)], [9, 9]);
});

Deno.test("interestedFrame has no payload beyond its id", () => {
  assertEquals(interestedFrame().length, 5);
});

/** Minimal fake satisfying only what `FramedConn` calls: `read` and `write`. */
function fakeConn(chunks: Uint8Array[]): Deno.Conn {
  let i = 0;
  return {
    read(buf: Uint8Array) {
      if (i >= chunks.length) return Promise.resolve(null);
      const chunk = chunks[i++]!;
      buf.set(chunk, 0);
      return Promise.resolve(chunk.length);
    },
    write(data: Uint8Array) {
      return Promise.resolve(data.length);
    },
  } as unknown as Deno.Conn;
}

Deno.test("readMessage decodes a keepalive as the synthetic MSG_KEEPALIVE id", async () => {
  const conn = new FramedConn(fakeConn([new Uint8Array(4)]));
  const message = await readMessage(conn);
  assertEquals(message.id, MSG_KEEPALIVE);
  assertEquals(message.payload.length, 0);
});

Deno.test("readMessage decodes a bitfield split across multiple reads", async () => {
  const body = frame(MSG_BITFIELD, new Uint8Array([0b1010_0000]));
  // Split the frame into two arbitrary chunks to exercise FramedConn's accumulate-and-slice path.
  const conn = new FramedConn(fakeConn([body.subarray(0, 3), body.subarray(3)]));
  const message = await readMessage(conn);
  assertEquals(message.id, MSG_BITFIELD);
  assertEquals([...message.payload], [0b1010_0000]);
});

Deno.test("readMessage rejects an oversized announced length", async () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, 10_000_000);
  const conn = new FramedConn(fakeConn([header]));
  await assertRejects(() => readMessage(conn), WireError);
});

Deno.test("parseHave decodes a 4-byte piece index", () => {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, 42);
  assertEquals(parseHave(payload), 42);
});
