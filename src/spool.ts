import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface SpoolEnvelope {
  event: Record<string, unknown>;
  sig: string;
}

export interface SpoolStore {
  write(envelopes: SpoolEnvelope[]): void;
  list(): { file: string; envelopes: SpoolEnvelope[]; corrupt: number }[];
  remove(file: string): void;
}

export function createSpool(dir: string): SpoolStore {
  mkdirSync(dir, { recursive: true });

  return {
    write(envelopes) {
      if (envelopes.length === 0) return;
      const name = `halvor-spool-${Date.now()}-${randomBytes(4).toString('hex')}.jsonl`;
      const tmp = join(dir, `.${name}.tmp`);
      const path = join(dir, name);
      const body = envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, path);
    },

    list() {
      const files = readdirSync(dir)
        .filter((f) => f.startsWith('halvor-spool-') && f.endsWith('.jsonl'))
        .sort();
      return files.map((file) => {
        const text = readFileSync(join(dir, file), 'utf8');
        const envelopes: SpoolEnvelope[] = [];
        let corrupt = 0;
        for (const line of text.split('\n')) {
          if (line.trim().length === 0) continue;
          try {
            const parsed = JSON.parse(line) as SpoolEnvelope;
            if (
              parsed &&
              typeof parsed === 'object' &&
              parsed.event &&
              typeof parsed.sig === 'string'
            ) {
              envelopes.push(parsed);
            } else {
              corrupt++;
            }
          } catch {
            corrupt++;
          }
        }
        return { file, envelopes, corrupt };
      });
    },

    remove(file) {
      try {
        unlinkSync(join(dir, file));
      } catch {
        // already gone
      }
    },
  };
}
