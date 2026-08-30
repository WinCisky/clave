/**
 * What is on disk, across every torrent — read from OPFS directly, no worker needed.
 *
 * The stream worker owns the file while a session is live (its sync access handle is exclusive),
 * but between sessions — which is exactly when this page wants to list, describe or delete things —
 * nothing holds a lock, so plain directory reads work fine from the main thread.
 *
 * Each torrent lives at `root/<infoHash>/`, holding the video, a `<name>.bitmap` of verified pieces,
 * and a `<name>.meta.json` sidecar the stream worker writes once storage opens. The sidecar is what
 * makes a directory of raw bytes describable — a bitmap alone cannot say whose it is, and the video
 * file is truncated to its full length up front, so its size on disk is never how much has arrived.
 */

/** Read one torrent directory's stored files, one entry per `*.meta.json` found in it. */
async function readTorrentDir(infoHash, dir) {
  const entries = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".meta.json")) continue;
    const fileName = name.slice(0, -".meta.json".length);
    let meta = null;
    try {
      const file = await handle.getFile();
      meta = JSON.parse(await file.text());
    } catch {
      // A sidecar that fails to parse still names a file worth deleting; it just cannot be described.
    }

    let verified = null;
    if (meta !== null) {
      try {
        const bitmapHandle = await dir.getFileHandle(`${fileName}.bitmap`);
        const bitmapFile = await bitmapHandle.getFile();
        const bits = new Uint8Array(await bitmapFile.arrayBuffer());
        verified = countBits(bits, meta.pieceTotal ?? 0);
      } catch {
        verified = null;
      }
    }

    const pieceTotal = meta?.pieceTotal ?? null;
    const complete = verified !== null && pieceTotal !== null && verified >= pieceTotal;
    const fileLength = meta?.fileLength ?? null;
    const bytesStored = verified !== null && pieceTotal !== null && fileLength !== null
      ? Math.min(fileLength, Math.round((verified / pieceTotal) * fileLength))
      : null;

    entries.push({
      infoHash,
      fileName,
      magnet: meta?.magnet || null,
      torrentName: meta?.torrentName ?? null,
      filePath: meta?.filePath ?? fileName,
      fileLength,
      pieceTotal,
      verified,
      complete,
      bytesStored,
    });
  }
  return entries;
}

function countBits(bytes, total) {
  let n = 0;
  const limit = Math.min(total, bytes.length * 8);
  for (let bit = 0; bit < limit; bit++) {
    if ((bytes[bit >> 3] & (1 << (bit & 7))) !== 0) n++;
  }
  return n;
}

/** Every stored file, across every torrent directory. */
export async function listStored() {
  const root = await navigator.storage.getDirectory();
  const out = [];
  for await (const [infoHash, handle] of root.entries()) {
    if (handle.kind !== "directory") continue;
    try {
      out.push(...(await readTorrentDir(infoHash, handle)));
    } catch {
      // A directory that cannot be read is skipped rather than failing the whole list.
    }
  }
  return out;
}

/** Remove one stored file — the video, its bitmap and its sidecar — and the directory if now empty. */
export async function deleteStored(infoHash, fileName) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(infoHash);
  for (const suffix of ["", ".bitmap", ".meta.json"]) {
    await dir.removeEntry(`${fileName}${suffix}`).catch(() => {});
  }
  let empty = true;
  for await (const _ of dir.keys()) {
    empty = false;
    break;
  }
  if (empty) await root.removeEntry(infoHash).catch(() => {});
}

/** How much of the origin's storage quota is in use. */
export async function estimateUsage() {
  const estimate = await navigator.storage.estimate?.();
  return { usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0 };
}
