/**
 * Minimal ustar archive writer.
 *
 * The panel has tar but no sftp server and no guarantee of gzip, and the
 * Homebridge host may not have a tar binary (Windows), so the installer
 * streams a plain tar it builds itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface TarEntry {
  /** Forward-slash relative path. */
  path: string;
  data: Buffer;
  mode?: number;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** Split a path into ustar `prefix` (≤155) and `name` (≤100). */
export function splitPath(path: string): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) {
    return { prefix: '', name: path };
  }
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) {
      return { prefix, name };
    }
  }
  throw new Error(`path too long for ustar: ${path}`);
}

function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(512);
  const { prefix, name } = splitPath(entry.path);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(entry.mode ?? 0o644, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii'); // uid root
  block.write(octal(0, 8), 116, 8, 'ascii'); // gid root
  block.write(octal(entry.data.length, 12), 124, 12, 'ascii');
  block.write(octal(0, 12), 136, 12, 'ascii'); // mtime: reproducible
  block.fill(' ', 148, 156); // checksum placeholder
  block.write('0', 156, 1, 'ascii'); // regular file
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write('root', 265, 32, 'ascii');
  block.write('root', 297, 32, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}

export function createTar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      throw new Error(`unsafe tar path: ${entry.path}`);
    }
    chunks.push(header(entry), entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/** Recursively collect regular files under `root` as tar entries below `prefix`. */
export function collectFiles(root: string, prefix: string): TarEntry[] {
  const entries: TarEntry[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '__pycache__' || name.endsWith('.pyc')) {
        continue;
      }
      const full = join(dir, name);
      const relative = rel ? `${rel}/${name}` : name;
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full, relative);
      } else if (stats.isFile()) {
        entries.push({ path: `${prefix}/${relative}`, data: readFileSync(full) });
      }
    }
  };
  walk(root, '');
  return entries;
}
