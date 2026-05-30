// 纯 JS tar.gz 提取器（Workers 兼容，利用内置 DecompressionStream）

export class TarGzReader {
  private buffer: Uint8Array | null = null;

  async load(tarGzBuffer: Uint8Array): Promise<void> {
    // gunzip
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(tarGzBuffer);
    writer.close();

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new Uint8Array(value));
      total += value.length;
    }

    // Flatten
    const tar = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      tar.set(c, offset);
      offset += c.length;
    }
    this.buffer = tar;
  }

  getFile(filename: string): Uint8Array | null {
    const entry = this.findEntry(filename);
    return entry ? entry.data : null;
  }

  // 单次遍历 tar：同时提取 sqlite + 收集所有 uploads 条目
  // 性能优化：原来需要 forEachFile(getFile) + forEachFile(uploads) 两次扫描，现在一次完成
  extractAll(): { sqliteBuf: Uint8Array | null; uploadEntries: { key: string; data: Uint8Array }[] } {
    if (!this.buffer) return { sqliteBuf: null, uploadEntries: [] };

    const buf = this.buffer;
    let pos = 0;
    let sqliteBuf: Uint8Array | null = null;
    const uploadEntries: { key: string; data: Uint8Array }[] = [];

    while (pos + 512 <= buf.length) {
      const nameEnd = buf.indexOf(0, pos);
      if (nameEnd === -1 || nameEnd > pos + 100) break;
      const rawName = new TextDecoder().decode(buf.slice(pos, nameEnd));
      if (!rawName) break;

      const sizeStr = new TextDecoder().decode(buf.slice(pos + 124, pos + 136)).replace(/\0/g, '').trim();
      const size = sizeStr ? parseInt(sizeStr, 8) : 0;
      const dataStart = pos + 512;
      const cleanName = rawName.startsWith('./') ? rawName.slice(2) : rawName;

      if (size > 0 && dataStart + size <= buf.length) {
        if (cleanName === 'data/db.sqlite') {
          sqliteBuf = buf.slice(dataStart, dataStart + size);
        } else if (cleanName.startsWith('uploads/') && !cleanName.includes('/thumbs/')) {
          const key = cleanName.replace(/^uploads\//, '');
          if (key) uploadEntries.push({ key, data: buf.slice(dataStart, dataStart + size) });
        }
      }

      const dataBlocks = Math.ceil(size / 512);
      pos += 512 + dataBlocks * 512;
      if (pos >= buf.length) break;
    }

    return { sqliteBuf, uploadEntries };
  }

  // 遍历 tar 中所有文件
  forEachFile(fn: (name: string, data: Uint8Array) => void): void {
    if (!this.buffer) return;
    const buf = this.buffer;
    let pos = 0;

    while (pos + 512 <= buf.length) {
      const nameEnd = buf.indexOf(0, pos);
      if (nameEnd === -1 || nameEnd > pos + 100) break;
      const name = new TextDecoder().decode(buf.slice(pos, nameEnd));
      if (!name) break;

      const sizeStr = new TextDecoder().decode(buf.slice(pos + 124, pos + 136)).replace(/\0/g, '').trim();
      const size = sizeStr ? parseInt(sizeStr, 8) : 0;

      const dataStart = pos + 512;
      const cleanName = name.startsWith('./') ? name.slice(2) : name;

      if (size > 0 && dataStart + size <= buf.length) {
        fn(cleanName, buf.slice(dataStart, dataStart + size));
      }

      const dataBlocks = Math.ceil(size / 512);
      pos += 512 + dataBlocks * 512;
      if (pos >= buf.length) break;
    }
  }

  private findEntry(filename: string): { data: Uint8Array } | null {
    if (!this.buffer) return null;
    let result: { data: Uint8Array } | null = null;
    this.forEachFile((name, data) => {
      if (name === filename || name === './' + filename) result = { data };
    });
    return result;
  }
}
