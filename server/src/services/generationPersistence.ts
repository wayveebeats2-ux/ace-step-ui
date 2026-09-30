import { randomUUID } from 'node:crypto';
import { db } from '../db/pool.js';
import type { GenerationParams, JobStatus } from './acestep-types.js';

function songTitle(params: GenerationParams): string {
  if (params.title?.trim()) return params.title.trim();
  if (!params.instrumental && params.lyrics) {
    const line = params.lyrics.split('\n').map(value => value.trim()).find(value => value && !/^\[.*\]$/.test(value));
    if (line) return line.length > 40 ? line.slice(0, 40).trimEnd() + '…' : line;
  }
  const source = (params.style || params.songDescription || '').trim().split(/\s+/).slice(0, 4).join(' ');
  return source ? source.charAt(0).toUpperCase() + source.slice(1) : 'Untitled';
}

export async function persistGenerationOutcome(localJobId: string, userId: string, params: GenerationParams, outcome: JobStatus): Promise<void> {
  db.transaction(() => {
    const job = db.prepare('SELECT status FROM generation_jobs WHERE id = ?').get(localJobId) as { status: string } | undefined;
    if (!job || ['succeeded', 'failed'].includes(job.status)) return;
    if (outcome.status === 'failed') {
      db.prepare("UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
        .run(outcome.error || 'Generation failed', localJobId);
      return;
    }
    const result = outcome.result;
    if (outcome.status !== 'succeeded' || !result?.audioUrls.length) throw new Error('Cannot save an incomplete generation');
    const insert = db.prepare(`INSERT INTO songs
      (id, user_id, title, lyrics, style, caption, audio_url, duration, bpm, key_scale, time_signature,
       tags, is_public, generation_params, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 1, ?, datetime('now'), datetime('now'))`);
    result.audioUrls.forEach((url, index) => {
      const title = songTitle(params) + (result.audioUrls.length > 1 ? ` (v${index + 1})` : '');
      // REST generation already downloaded this unique file. Reuse it instead of making a second copy.
      insert.run(randomUUID(), userId, title, params.instrumental ? '[Instrumental]' : (params.lyrics || ''),
        params.style || params.songDescription || '', params.style || params.songDescription || '', url,
        result.duration > 0 ? result.duration : 0, result.bpm || null, result.keyScale || null,
        result.timeSignature || null, JSON.stringify(params));
    });
    db.prepare("UPDATE generation_jobs SET status = 'succeeded', result = ?, error = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(result), localJobId);
  })();
}

export function recoverInterruptedGenerations(): void {
  const result = db.prepare(`UPDATE generation_jobs SET status = 'failed',
    error = 'UI backend restarted before generation completed; submit a new generation', updated_at = datetime('now')
    WHERE status IN ('queued', 'pending', 'running')`).run();
  if (result.changes) console.warn(`[Generation] Marked ${result.changes} interrupted job(s) failed after backend restart`);
}
