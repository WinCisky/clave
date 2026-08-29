/**
 * Which peer addresses are worth dialling at all.
 *
 * `src/wire/conn.ts` tells callers to filter with `isRoutable` first, and the reason is a budget
 * rather than tidiness: Cloudflare allows only **six concurrent connecting sockets**, and a
 * connect the runtime refuses still occupies one of them until it fails. Six slots spent on
 * addresses that could never have worked is what a slow cold start actually looks like.
 *
 * Three groups are rejected, and the third is the one nobody expects:
 *
 *  1. Nonsense and non-global addresses — loopback, RFC1918, link-local, CGNAT, multicast,
 *     unspecified. Real peer lists genuinely contain `0.0.0.0` and port 1.
 *  2. Port 25, which Cloudflare blocks outright so Workers cannot send mail.
 *  3. **Cloudflare's own address space.** `connect()` refuses it, and peers do appear inside it:
 *     the 220-peer sample checked in at `fixtures/records-bbb.json` holds three addresses in
 *     `104.28.0.0/16`, which is WARP egress. They are not bad peers — they are peers a Worker
 *     structurally cannot reach, and they were indistinguishable from bad ones until this filter
 *     existed.
 *
 * A hostname that is not an IP literal is allowed through: it cannot be classified here, and the
 * runtime will decide.
 */

/**
 * Cloudflare's published IPv4 space (https://www.cloudflare.com/ips-v4), plus one addition.
 *
 * The published list is the *proxy* list, and it is narrower than what Cloudflare owns: it splits
 * 104.16-104.27 into a /13 and a /14, while ARIN registers the whole of **104.16.0.0/12**
 * (104.16.0.0-104.31.255.255) as CLOUDFLARENET. The gap is not academic — the 220-peer sample in
 * `fixtures/records-bbb.json` holds three addresses in `104.28.x`, which the published list misses
 * and the /12 catches. Probed directly, all three time out from an ordinary host as well as from a
 * Worker: they are WARP egress with nothing listening. So the /12 is the right boundary here, and
 * it makes the two narrower entries redundant — they are kept because this list is meant to be
 * diffable against the published one.
 */
export const CLOUDFLARE_V4: readonly string[] = [
  "104.16.0.0/12",
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

export const CLOUDFLARE_V6: readonly string[] = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** Not globally routable, or reserved. `172.16/12` is private; Cloudflare's `172.64/13` is above. */
const NON_GLOBAL_V4: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

const NON_GLOBAL_V6: readonly string[] = [
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

/** Cloudflare blocks outbound SMTP, so a peer advertising port 25 is unreachable by definition. */
const BLOCKED_PORTS = new Set([25]);

interface Cidr4 {
  readonly base: number;
  readonly mask: number;
}

function parseIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function parseCidr4(text: string): Cidr4 {
  const [address, bits] = text.split("/");
  const base = parseIpv4(address!);
  const width = Number(bits);
  if (base === null || !Number.isInteger(width) || width < 0 || width > 32) {
    throw new Error(`bad IPv4 CIDR "${text}"`);
  }
  // `>>> 0` keeps the mask unsigned; a /0 shifts by 32, which JS would wrap to a no-op.
  const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

/** Sixteen bytes, or null if `text` is not an IPv6 literal. Accepts `[…]` and `::ffff:1.2.3.4`. */
function parseIpv6(text: string): Uint8Array | null {
  let body = text;
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  // A zone index (`%eth0`) is meaningful only locally, and a local address is rejected anyway.
  const zone = body.indexOf("%");
  if (zone !== -1) body = body.slice(0, zone);
  if (!body.includes(":")) return null;

  // A trailing dotted quad is the IPv4-mapped form; convert it to two hex groups first.
  const lastColon = body.lastIndexOf(":");
  const tail = body.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const high = ((v4 >>> 16) & 0xffff).toString(16);
    const low = (v4 & 0xffff).toString(16);
    body = `${body.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = body.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (group.length === 0 || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = groupsOf(halves[0]!);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const rest = groupsOf(halves[1]!);
    if (rest === null || head.length + rest.length > 7) return null;
    groups = [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i]! >>> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

interface Cidr6 {
  readonly base: Uint8Array;
  readonly bits: number;
}

function parseCidr6(text: string): Cidr6 {
  const [address, width] = text.split("/");
  const base = parseIpv6(address!);
  const bits = Number(width);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 128) {
    throw new Error(`bad IPv6 CIDR "${text}"`);
  }
  return { base, bits };
}

function inCidr4(address: number, cidr: Cidr4): boolean {
  return ((address & cidr.mask) >>> 0) === cidr.base;
}

function inCidr6(address: Uint8Array, cidr: Cidr6): boolean {
  const whole = cidr.bits >> 3;
  for (let i = 0; i < whole; i++) if (address[i] !== cidr.base[i]) return false;
  const spare = cidr.bits & 7;
  if (spare === 0) return true;
  const mask = (0xff << (8 - spare)) & 0xff;
  return (address[whole]! & mask) === (cidr.base[whole]! & mask);
}

// Parsed once at module load: these lists are constant and the predicate runs per dial.
const BLOCKED_V4 = [...CLOUDFLARE_V4, ...NON_GLOBAL_V4].map(parseCidr4);
const BLOCKED_V6 = [...CLOUDFLARE_V6, ...NON_GLOBAL_V6].map(parseCidr6);

/** `255.255.255.255`, which no CIDR above covers on its own. */
const BROADCAST_V4 = 0xffffffff;

/**
 * Whether `connect()` has any chance of reaching this address.
 *
 * False means do not spend a connecting slot on it. True means "not provably unreachable" — the
 * runtime may still refuse it, which is why the caller must handle a failed dial regardless.
 */
export function isRoutable(hostname: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (BLOCKED_PORTS.has(port)) return false;

  const v4 = parseIpv4(hostname);
  if (v4 !== null) {
    if (v4 === BROADCAST_V4) return false;
    return !BLOCKED_V4.some((cidr) => inCidr4(v4, cidr));
  }

  const v6 = parseIpv6(hostname);
  if (v6 !== null) {
    // An IPv4-mapped address must be judged by its IPv4 rules, not only its v6 ones.
    const mapped = isIpv4Mapped(v6);
    if (mapped !== null) {
      if (mapped === BROADCAST_V4) return false;
      if (BLOCKED_V4.some((cidr) => inCidr4(mapped, cidr))) return false;
    }
    return !BLOCKED_V6.some((cidr) => inCidr6(v6, cidr));
  }

  // Not an IP literal. Nothing here can classify it; let the runtime decide.
  return hostname.length > 0;
}

function isIpv4Mapped(bytes: Uint8Array): number | null {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return null;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return ((bytes[12]! << 24) | (bytes[13]! << 16) | (bytes[14]! << 8) | bytes[15]!) >>> 0;
}
