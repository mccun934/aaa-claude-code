import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
export const CACHE_DIR = path.join(ROOT, '.cache');
export const STRUDEL_REPL_DIST = path.join(ROOT, 'node_modules', '@strudel', 'repl', 'dist');
