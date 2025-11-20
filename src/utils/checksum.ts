import { randomBytes } from 'crypto';

export function getOrGenerateClientKey(): string {
  return randomBytes(16).toString('hex');
}

