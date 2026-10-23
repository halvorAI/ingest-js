import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface SpoolEnvelope {
  event: Record<string, unknown>;
  sig: string;
}

export interface SpoolFile {
  envelopes: SpoolEnvelope[];
  corrupt: number;
}

export interface SpoolLimits {
  /** Total bytes of pending spool files before the oldest are evicted. */
  maxBytes: number;
  /** Pending files older than this are evicted. */
  maxAgeMs: number;
}

export interface EvictionResult {
  files: number;
  events: number;
}

export interface SpoolStore {
  /** Writes a new pending file, then enforces the size and age limits. */
  write(envelopes: SpoolEnvelope[]): Promise<EvictionResult>;
  /** Pending file names, oldest first. Nothing is read into memory. */
  files(): Promise<string[]>;
  /** Reads one pending file. A missing file reads as empty. */
  read(file: string): Promise<SpoolFile>;
  /** Replaces a pending file's contents, keeping its place in the order. */
  rewrite(file: string, envelopes: SpoolEnvelope[]): Promise<void>;
  remove(file: string): Promise<void>;
  /** Keeps events the API will never accept in `dead/` for inspection. They are never replayed. */
  deadLetter(envelopes: SpoolEnvelope[]): Promise<void>;
}

export const DEFAULT_SPOOL_LIMITS: SpoolLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

const PREFIX = 'halvor-spool-';
const SUFFIX = '.jsonl';
const DEAD_DIR = 'dead';

function fileName(): string {
  // Zero-padded time keeps lexical order equal to age order.
  return `${PREFIX}${String(Date.now()).padStart(15, '0')}-${randomBytes(4).toString('hex')}${SUFFIX}`;
}

function serialize(envelopes: SpoolEnvelope[]): string {
  return envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function countLines(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (line.trim().length > 0) n++;
  return n;
}

async function atomicWrite(dir: string, name: string, body: string): Promise<void> {
  const tmp = join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, join(dir, name));
}

export function createSpool(dir: string, limits: Partial<SpoolLimits> = {}): SpoolStore {
  const { maxBytes, maxAgeMs } = { ...DEFAULT_SPOOL_LIMITS, ...limits };
  let ready: Promise<void> | null = null;
  const ensureDir = (): Promise<void> => {
    ready ??= mkdir(dir, { recursive: true }).then(() => undefined);
    return ready;
  };

  async function list(inDir: string): Promise<string[]> {
    const names = await readdir(inDir);
    return names.filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX)).sort();
  }

  async function files(): Promise<string[]> {
    await ensureDir();
    return list(dir);
  }

  /** Deletes the oldest files in `inDir` until it is under the size limit and nothing is too old. */
  async function evict(inDir: string): Promise<EvictionResult> {
    const result: EvictionResult = { files: 0, events: 0 };
    const now = Date.now();
    const entries: { name: string; size: number; mtimeMs: number }[] = [];
    for (const name of await list(inDir)) {
      try {
        const s = await stat(join(inDir, name));
        entries.push({ name, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        // removed concurrently
      }
    }
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries) {
      const tooOld = now - entry.mtimeMs > maxAgeMs;
      if (!tooOld && total <= maxBytes) continue;
      try {
        const text = await readFile(join(inDir, entry.name), 'utf8');
        await unlink(join(inDir, entry.name));
        result.files++;
        result.events += countLines(text);
        total -= entry.size;
      } catch {
        // already gone
      }
    }
    return result;
  }

  return {
    async write(envelopes) {
      if (envelopes.length === 0) return { files: 0, events: 0 };
      await ensureDir();
      await atomicWrite(dir, fileName(), serialize(envelopes));
      return evict(dir);
    },

    files,

    async read(file) {
      let text: string;
      try {
        text = await readFile(join(dir, file), 'utf8');
      } catch {
        return { envelopes: [], corrupt: 0 };
      }
      const envelopes: SpoolEnvelope[] = [];
      let corrupt = 0;
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(line) as SpoolEnvelope;
          if (parsed && typeof parsed === 'object' && parsed.event && typeof parsed.sig === 'string') {
            envelopes.push(parsed);
          } else {
            corrupt++;
          }
        } catch {
          corrupt++;
        }
      }
      return { envelopes, corrupt };
    },

    async rewrite(file, envelopes) {
      if (envelopes.length === 0) {
        await unlink(join(dir, file)).catch(() => undefined);
        return;
      }
      await atomicWrite(dir, file, serialize(envelopes));
    },

    async remove(file) {
      await unlink(join(dir, file)).catch(() => undefined);
    },

    async deadLetter(envelopes) {
      if (envelopes.length === 0) return;
      const deadDir = join(dir, DEAD_DIR);
      await mkdir(deadDir, { recursive: true });
      await atomicWrite(deadDir, fileName(), serialize(envelopes));
      await evict(deadDir);
    },
  };
}
