/* Minimal .zip / .tgz / .gz reader using the browser's DecompressionStream. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.archive = (() => {
  async function inflate(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Returns [{name, data: Uint8Array}] for every file in a zip. */
  async function unzip(buf, wanted = () => true) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = [];
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Bad zip directory');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commLen;
      if (name.endsWith('/') || !wanted(name)) continue;
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflate(raw, 'deflate-raw');
      else throw new Error('Unsupported zip compression method ' + method);
      files.push({ name, data });
    }
    return files;
  }

  /** Reads a tar (already un-gzipped). */
  function untar(u8, wanted = () => true) {
    const files = [];
    const dec = new TextDecoder();
    let p = 0;
    while (p + 512 <= u8.length) {
      const header = u8.subarray(p, p + 512);
      if (header.every(b => b === 0)) break;
      const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/s, '');
      const size = parseInt(dec.decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8);
      const type = String.fromCharCode(header[156] || 48);
      p += 512;
      if ((type === '0' || type === '\0') && wanted(name)) files.push({ name, data: u8.slice(p, p + size) });
      p += Math.ceil(size / 512) * 512;
    }
    return files;
  }

  /** Given a File/ArrayBuffer + filename, return the text of the first .json inside. */
  async function readJsonText(buf, filename) {
    const u8 = new Uint8Array(buf);
    const isJson = n => /\.json$/i.test(n);
    let data;
    if (u8[0] === 0x50 && u8[1] === 0x4b) {
      const files = await unzip(u8, isJson);
      if (!files.length) throw new Error('No .json file inside the zip');
      data = files[0].data;
    } else if (u8[0] === 0x1f && u8[1] === 0x8b) {
      const raw = await inflate(u8, 'gzip');
      // .tgz (tar inside) or plain .json.gz
      const looksTar = raw.length > 512 && new TextDecoder().decode(raw.subarray(257, 262)) === 'ustar';
      if (looksTar) {
        const files = untar(raw, isJson);
        if (!files.length) throw new Error('No .json file inside the archive');
        data = files[0].data;
      } else data = raw;
    } else data = u8;
    return new TextDecoder().decode(data);
  }

  return { unzip, untar, readJsonText, inflate };
})();

if (typeof module !== 'undefined') module.exports = JA;
