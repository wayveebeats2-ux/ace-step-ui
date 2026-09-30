import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { LocalStorageProvider } from '../services/storage/local.js';

const storage = new LocalStorageProvider();
const directory = `storage-test-${randomUUID()}`;
const original = `${directory}/original.wav`;
const copied = `${directory}/copied.wav`;
const audioDir = config.storage.audioDir;
const contents = Buffer.from('storage smoke test');

try {
  assert.equal(await storage.exists(original), false);
  assert.equal(await storage.upload(original, contents, 'audio/wav'), original);
  assert.equal(await storage.exists(original), true);
  assert.deepEqual(await readFile(path.join(audioDir, original)), contents);
  assert.equal(await storage.getUrl(original), `/audio/${original}`);
  assert.equal(storage.getPublicUrl(`/audio/${original}`), `/audio/${original}`);
  await storage.copy(original, copied);
  assert.deepEqual(await readFile(path.join(audioDir, copied)), contents);
  await storage.delete(original);
  assert.equal(await storage.exists(original), false);
  await storage.delete(original);
  console.log('[test-storage] Upload, read, URLs, copy, delete, and missing-file deletion passed');
} finally {
  await storage.delete(original);
  await storage.delete(copied);
  await rmdir(path.join(audioDir, directory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
