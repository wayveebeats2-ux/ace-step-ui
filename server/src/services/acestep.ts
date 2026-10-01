import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import type { GenerationParams, GenerationResult, JobStatus } from './acestep-types.js';
import {
  audioExtension, buildReleaseTaskPayload, DEFAULT_DIT_MODEL, DESKTOP_LM_MODEL,
  engineAudioUrl, GENERATION_TIMEOUT_MS, parseTaskResult, requestEngineJson,
} from './acestep-rest.js';

export type { GenerationParams, GenerationResult, JobStatus } from './acestep-types.js';
export { resolvePythonPath } from './python-runtime.js';

interface ActiveJob extends JobStatus {
  params: GenerationParams;
  startTime: number;
  finishedAt?: number;
  rawResponse?: unknown;
  onFinished?: (status: JobStatus) => Promise<void>;
}

const activeJobs = new Map<string, ActiveJob>();
const jobQueue: string[] = [];
let isProcessingQueue = false;
const audioDir = config.storage.audioDir;
const cleanupTimer = setInterval(() => cleanupOldJobs(), 600_000);
cleanupTimer.unref();

export async function checkSpaceHealth(): Promise<boolean> {
  try {
    const response = await requestEngineJson('/health', undefined, 5_000);
    const health = response.data ?? response;
    return health.status === 'ok' && health.models_initialized !== false;
  } catch {
    return false;
  }
}

export async function discoverEndpoints(): Promise<unknown> {
  return {
    provider: 'acestep-rest', endpoint: config.acestep.apiUrl,
    health: '/health', submit: '/release_task', query: '/query_result', audio: '/v1/audio',
    lmBackend: 'pt', lmModel: DESKTOP_LM_MODEL,
  };
}

async function ensureModelLoaded(model: string): Promise<void> {
  const response = await requestEngineJson('/v1/models');
  const inventory = response.data ?? response;
  const models = Array.isArray(inventory) ? inventory : inventory.models;
  const entries = Array.isArray(models) ? models : [];
  const nameOf = (item: any): string | undefined => typeof item === 'string' ? item : item?.name || item?.id;
  const current = inventory.default_model || nameOf(entries.find((item: any) => item.is_default));
  // Older portable APIs list only initialized models and have no /v1/init.
  // A non-default loaded slot can also be selected directly by /release_task.
  if (entries.some((item: any) => nameOf(item) === model && item?.is_loaded !== false)) return;
  if (current === model && !entries.some((item: any) => nameOf(item) === model && item?.is_loaded === false)) return;
  if (!current && !entries.length) {
    // Unknown inventory must not turn an otherwise valid generation into an
    // unsupported model-init request. Let /release_task validate its selection.
    console.warn(`[Model] Inventory did not identify loaded models; submitting ${model} directly to /release_task`);
    return;
  }
  const schema = await requestEngineJson('/openapi.json');
  if (!schema.paths?.['/v1/init']?.post) {
    throw new Error(`This ACE-Step engine cannot load ${model} on demand. Select an already-loaded model (${entries.map(nameOf).filter(Boolean).join(', ') || current || 'unknown'}) or update the official engine.`);
  }
  // Switch the primary slot, rather than preloading multiple DiTs on an 8 GB GPU.
  console.log(`[Model] Switching primary DiT ${current || 'unknown'} -> ${model}`);
  await requestEngineJson('/v1/init', { model, init_llm: false }, 15 * 60_000);
}

async function localAudioPath(audioUrl: string): Promise<string> {
  // Reference files supplied by the UI live in our local audio library.
  const pathname = audioUrl.startsWith('/audio/') ? audioUrl : new URL(audioUrl).pathname;
  if (!pathname.startsWith('/audio/')) throw new Error('Source/reference audio must be uploaded to the local library');
  const root = await realpath(audioDir);
  const file = await realpath(path.resolve(root, decodeURIComponent(pathname.slice('/audio/'.length))));
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Audio path is outside the local library');
  return file;
}

async function stageAudio(params: GenerationParams, body: Record<string, unknown>): Promise<string | undefined> {
  if (!params.referenceAudioUrl && !params.sourceAudioUrl) return;
  // Current ACE-Step permits absolute input paths only under the OS temp directory.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ace-step-ui-'));
  try {
    for (const [url, field, name] of [
      [params.referenceAudioUrl, 'reference_audio_path', 'reference'],
      [params.sourceAudioUrl, 'src_audio_path', 'source'],
    ]) {
      if (!url) continue;
      const source = await localAudioPath(url);
      const destination = path.join(directory, `${name}${path.extname(source)}`);
      await copyFile(source, destination);
      body[field!] = destination;
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return value !== null && value !== '' && Number.isFinite(number) && number > 0 ? number : undefined;
}

async function runRestGeneration(jobId: string, job: ActiveJob): Promise<GenerationResult> {
  const payload = buildReleaseTaskPayload(job.params);
  let stagedDirectory: string | undefined;
  const downloadedPaths: string[] = [];
  try {
    await ensureModelLoaded(String(payload.model || DEFAULT_DIT_MODEL));
    stagedDirectory = await stageAudio(job.params, payload);
    console.log(`[Generation ${jobId}] Submit ${JSON.stringify({
      model: payload.model, lm_backend: payload.lm_backend, lm_model_path: payload.lm_model_path,
      audio_duration: payload.audio_duration ?? 'auto', batch_size: payload.batch_size,
      inference_steps: payload.inference_steps, thinking: payload.thinking, use_format: payload.use_format,
      allow_lm_batch: payload.allow_lm_batch,
    })}`);
    const submit = await requestEngineJson('/release_task', payload);
    const taskId = submit.data?.task_id;
    if (!taskId) throw new Error('ACE-Step did not return a task id');
    job.stage = 'Generating audio...';
    console.log(`[Generation ${jobId}] ACE-Step task ${taskId}`);
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    let lastStage = '';
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_500));
      const query = await requestEngineJson('/query_result', { task_id_list: [String(taskId)] }, Math.min(30_000, Math.max(1, deadline - Date.now())));
      job.rawResponse = query;
      const task = query.data?.find((item: any) => String(item.task_id) === String(taskId)) ?? query.data?.[0];
      if (!task) throw new Error('ACE-Step query_result returned no task');
      const items = parseTaskResult(task);
      job.stage = task.progress_text || items[0]?.stage || job.stage;
      const progress = Number(items[0]?.progress);
      if (Number.isFinite(progress)) job.progress = progress;
      if (job.stage && job.stage !== lastStage) {
        console.log(`[Generation ${jobId}] ${job.stage}`);
        lastStage = job.stage;
      }
      if (Number(task.status) !== 1) continue;
      job.stage = 'Saving audio to library...';
      const audioUrls: string[] = [];
      let metadata: any = {};
      for (const item of items) {
        if (!item?.file) continue;
        const url = engineAudioUrl(String(item.file));
        const filename = `${jobId}_${audioUrls.length}${audioExtension(url, String(payload.audio_format))}`;
        const destination = path.join(audioDir, filename);
        await mkdir(audioDir, { recursive: true });
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`Generated audio download failed (HTTP ${response.status})`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new Error('ACE-Step returned an empty audio file');
        const temporary = destination + '.tmp';
        downloadedPaths.push(temporary, destination);
        await writeFile(temporary, buffer);
        await rename(temporary, destination);
        audioUrls.push(`/audio/${filename}`);
        metadata = items.find(value => value?.metas)?.metas ?? {};
      }
      if (!audioUrls.length) throw new Error('ACE-Step completed but returned no audio files');
      return {
        audioUrls, duration: optionalNumber(metadata.duration) ?? optionalNumber(job.params.duration) ?? 0,
        bpm: optionalNumber(metadata.bpm) ?? job.params.bpm,
        keyScale: metadata.keyscale && metadata.keyscale !== 'N/A' ? metadata.keyscale : job.params.keyScale,
        timeSignature: metadata.timesignature && metadata.timesignature !== 'N/A' ? metadata.timesignature : job.params.timeSignature,
        status: 'succeeded',
      };
    }
    throw new Error('ACE-Step generation timed out after 15 minutes; check logs/ace-step.log');
  } catch (error) {
    await Promise.all(downloadedPaths.map(file => rm(file, { force: true })));
    throw error;
  } finally {
    if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true });
  }
}

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    while (jobQueue.length) {
      const jobId = jobQueue[0];
      const job = activeJobs.get(jobId)!;
      job.status = 'running';
      job.stage = 'Submitting to ACE-Step API...';
      try {
        const result = await runRestGeneration(jobId, job);
        // Complete durable library writes before telling the UI the job succeeded.
        await job.onFinished?.({ status: 'succeeded', result });
        job.result = result;
        job.status = 'succeeded';
        job.stage = 'Complete';
        job.progress = 1;
        console.log(`[Generation ${jobId}] Complete: ${result.audioUrls.length} audio file(s), ${Math.round((Date.now() - job.startTime) / 1000)}s elapsed`);
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        job.stage = 'Failed';
        console.error(`[Generation ${jobId}] Failed: ${job.error}`);
        try { await job.onFinished?.({ status: 'failed', error: job.error }); }
        catch (persistError) { console.error(`[Generation ${jobId}] Failed to persist failure`, persistError); }
      } finally {
        job.finishedAt = Date.now();
        jobQueue.shift();
        jobQueue.forEach((id, index) => { activeJobs.get(id)!.queuePosition = index + 1; });
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

export async function generateMusicViaAPI(params: GenerationParams, onFinished?: ActiveJob['onFinished']): Promise<{ jobId: string }> {
  buildReleaseTaskPayload(params); // Reject invalid requests before enqueueing or loading a model.
  const jobId = `job_${randomUUID()}`;
  activeJobs.set(jobId, { params, startTime: Date.now(), status: 'queued', queuePosition: jobQueue.length + 1, onFinished });
  jobQueue.push(jobId);
  // Let the submitting route save the local-to-engine job mapping first.
  setImmediate(() => { void processQueue().catch(error => console.error('[Generation queue]', error)); });
  return { jobId };
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const job = activeJobs.get(jobId);
  if (!job) return { status: 'failed', error: 'Backend restarted or job expired; submit a new generation' };
  return {
    status: job.status, queuePosition: job.status === 'queued' ? job.queuePosition : undefined,
    progress: job.progress, stage: job.stage, result: job.result, error: job.error,
  };
}

export function getJobRawResponse(jobId: string): unknown | null {
  return activeJobs.get(jobId)?.rawResponse ?? null;
}

export async function getAudioStream(audioPath: string): Promise<Response> {
  if (audioPath.startsWith('/audio/')) {
    try {
      const filename = await localAudioPath(audioPath);
      const buffer = await readFile(filename);
      const extension = path.extname(filename).toLowerCase();
      const contentType = extension === '.wav' ? 'audio/wav' : extension === '.flac' ? 'audio/flac' : 'audio/mpeg';
      return new Response(buffer, { headers: { 'Content-Type': contentType } });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  // Never proxy arbitrary URLs or read arbitrary local files from a query parameter.
  return fetch(engineAudioUrl(audioPath), { signal: AbortSignal.timeout(60_000) });
}

export function cleanupJob(jobId: string): void {
  const job = activeJobs.get(jobId);
  if (job?.finishedAt) activeJobs.delete(jobId);
}

export function cleanupOldJobs(maxAgeMs = 3_600_000): void {
  for (const [jobId, job] of activeJobs) {
    if (job.finishedAt && Date.now() - job.finishedAt > maxAgeMs) activeJobs.delete(jobId);
  }
}
