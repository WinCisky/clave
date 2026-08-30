/**
 * Which peer addresses this service is willing to open a socket to.
 *
 * Ported from `clave`'s `src/wire/addr.ts`, minus the Cloudflare-specific block: that filter
 * exists because a Cloudflare Worker's `connect()` cannot reach Cloudflare's own address space, and
 * this service is not a Worker. Everything else stays, because it is the actual SSRF guard: this
 * endpoint takes caller-supplied `ip:port` pairs and dials them, so it must refuse loopback,
 * private, link-local, CGNAT, multicast and reserved ranges the same way `isRoutable` does — the
 * caller (`clave`'s `rankPeers`) has already filtered those out of what a *Worker* can reach, but
 * this service has no such upstream guarantee and must not trust it.
 *
 * Only numeric IP literals are accepted upstream of this (see `probe.ts`); there is deliberately no
 * hostname path here, so there is no DNS-rebinding surface to reason about.
 */

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

/** Mail relaying is not this service's job, and a "peer" on port 25 is not a peer. */
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
  const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

function parseIpv6(text: string): Uint8Array | null {
  let body = text;
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  const zone = body.indexOf("%");
  if (zone !== -1) body = body.slice(0, zone);
  if (!body.includes(":")) return null;

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

const BLOCKED_V4 = NON_GLOBAL_V4.map(parseCidr4);
const BLOCKED_V6 = NON_GLOBAL_V6.map(parseCidr6);

const BROADCAST_V4 = 0xffffffff;

function isIpv4Mapped(bytes: Uint8Array): number | null {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return null;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return ((bytes[12]! << 24) | (bytes[13]! << 16) | (bytes[14]! << 8) | bytes[15]!) >>> 0;
}

/**
 * Whether this service is willing to dial `ip:port` at all.
 *
 * `ip` must be a numeric literal — the one and only address form this service accepts from a
 * caller. Anything else (a hostname) is rejected here rather than resolved, which is what keeps
 * DNS rebinding out of scope entirely.
 */
export function isDialable(ip: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (BLOCKED_PORTS.has(port)) return false;

  const v4 = parseIpv4(ip);
  if (v4 !== null) {
    if (v4 === BROADCAST_V4) return false;
    return !BLOCKED_V4.some((cidr) => inCidr4(v4, cidr));
  }

  const v6 = parseIpv6(ip);
  if (v6 !== null) {
    const mapped = isIpv4Mapped(v6);
    if (mapped !== null) {
      if (mapped === BROADCAST_V4) return false;
      if (BLOCKED_V4.some((cidr) => inCidr4(mapped, cidr))) return false;
    }
    return !BLOCKED_V6.some((cidr) => inCidr6(v6, cidr));
  }

  // Not a recognisable IP literal, so it is not a numeric address at all — refuse it rather than
  // hand it to `Deno.connect`, which would otherwise resolve it as a hostname.
  return false;
}
