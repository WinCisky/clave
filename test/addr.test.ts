/**
 * Which addresses are worth a connecting slot.
 *
 * The load-bearing case is the third block: peers inside Cloudflare's own address space. They
 * look like ordinary peers, they appear in real tracker output, and `connect()` refuses them — so
 * before this filter existed they were indistinguishable from peers that were merely dead, while
 * costing a full connect timeout each out of only six concurrent slots.
 */

import { describe, expect, it } from "vitest";
import { CLOUDFLARE_V4, isRoutable } from "../src/wire/addr.ts";
import fixture from "../fixtures/records-bbb.json";

describe("ports", () => {
  it("rejects out-of-range ports", () => {
    expect(isRoutable("1.2.3.4", 0)).toBe(false);
    expect(isRoutable("1.2.3.4", 65536)).toBe(false);
    expect(isRoutable("1.2.3.4", -1)).toBe(false);
    expect(isRoutable("1.2.3.4", 1.5)).toBe(false);
  });

  it("rejects port 25, which Cloudflare blocks outright", () => {
    expect(isRoutable("1.2.3.4", 25)).toBe(false);
    expect(isRoutable("1.2.3.4", 26)).toBe(true);
  });

  it("allows low ports other than 25 — nothing documents a blanket block below 1024", () => {
    expect(isRoutable("1.2.3.4", 80)).toBe(true);
    expect(isRoutable("1.2.3.4", 1)).toBe(true);
  });
});

describe("non-global IPv4", () => {
  const blocked = [
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "224.0.0.1",
    "255.255.255.255",
  ];
  for (const ip of blocked) {
    it(`rejects ${ip}`, () => expect(isRoutable(ip, 6881)).toBe(false));
  }

  it("allows ordinary public addresses", () => {
    for (const ip of ["46.232.211.217", "89.149.197.83", "8.8.8.8", "172.15.0.1", "172.32.0.1"]) {
      expect(isRoutable(ip, 6881)).toBe(true);
    }
  });
});

describe("Cloudflare's own space", () => {
  it("rejects an address from every published IPv4 prefix", () => {
    // One address inside each prefix, derived from the prefix itself so the test cannot drift
    // away from the list it is checking.
    for (const cidr of CLOUDFLARE_V4) {
      const base = cidr.split("/")[0]!;
      expect(isRoutable(base, 6881)).toBe(false);
    }
  });

  it("rejects WARP egress in 104.28.x, which the published proxy list misses", () => {
    expect(isRoutable("104.28.165.161", 42618)).toBe(false);
    expect(isRoutable("104.28.246.50", 63919)).toBe(false);
  });

  it("rejects Cloudflare IPv6", () => {
    expect(isRoutable("2606:4700::1111", 6881)).toBe(false);
    expect(isRoutable("[2400:cb00::1]", 6881)).toBe(false);
  });
});

describe("IPv6", () => {
  it("rejects loopback, unspecified, link-local, ULA and multicast", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd00::1", "ff02::1"]) {
      expect(isRoutable(ip, 6881)).toBe(false);
    }
  });

  it("allows a global unicast address, bracketed or bare", () => {
    expect(isRoutable("2001:db8::1", 6881)).toBe(true);
    expect(isRoutable("[2001:db8::1]", 6881)).toBe(true);
  });

  it("judges an IPv4-mapped address by its IPv4 rules", () => {
    expect(isRoutable("::ffff:127.0.0.1", 6881)).toBe(false);
    expect(isRoutable("::ffff:10.0.0.1", 6881)).toBe(false);
    expect(isRoutable("::ffff:104.28.165.161", 6881)).toBe(false);
    expect(isRoutable("::ffff:8.8.8.8", 6881)).toBe(true);
  });

  it("strips a zone index rather than choking on it", () => {
    expect(isRoutable("fe80::1%eth0", 6881)).toBe(false);
  });

  it("rejects malformed literals by falling through to the hostname branch", () => {
    // Not an IP literal, so unclassifiable — the runtime gets to decide.
    expect(isRoutable("peer.example.com", 6881)).toBe(true);
    expect(isRoutable("", 6881)).toBe(false);
  });
});

describe("against the real 220-peer sample", () => {
  const peers = fixture.peers.peers as { ip: string; port: number }[];

  it("has the sample it thinks it has", () => {
    expect(peers.length).toBe(220);
  });

  it("rejects exactly the three Cloudflare addresses and nothing else", () => {
    const rejected = peers.filter((p) => !isRoutable(p.ip, p.port)).map((p) => `${p.ip}:${p.port}`);
    expect(rejected.sort()).toEqual([
      "104.28.165.161:42618",
      "104.28.165.238:42618",
      "104.28.246.50:63919",
    ]);
  });
});
