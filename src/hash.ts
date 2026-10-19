import { createHash } from 'node:crypto';

/** APE instruction digest: `sha256:` + hex of the UTF-8 instruction text. */
export function hashInstruction(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
