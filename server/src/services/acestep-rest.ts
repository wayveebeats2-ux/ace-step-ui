import path from 'node:path';
import type { GenerationParams } from './acestep-types.js';
import { config } from '../config/index.js';

export const DESKTOP_LM_MODEL = 'acestep-5Hz-lm-0.6B';
export const DEFAULT_DIT_MODEL = 'acestep-v15-turbo';
export const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

export function isTurboModel(model: string): boolean {
  return /turbo|dmd/i.test(model);
}

// OpenRouter's /v1/models uses provider-qualified IDs and human-readable names.
// Both refer to the same internal DiT name accepted by /release_task.
export function engineModelName(item: unknown): string | undefined {
  const entry = item as { id?: string; name?: string } | undefined;
  const value = typeof item === 'string' ? item : entry?.id || entry?.name;
  if (typeof value !== 'string') return undefined;
  return value.trim().replace(/^acestep\//i, '').replace(/^ACE-Step\s+/i, '');
}

function numberInRange(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback;
}

// Field names match ACE-Step's GenerateMusicRequest and release-task parser.
export function buildReleaseTaskPayload(params: GenerationParams): Record<string, unknown> {
  const model = params.ditModel || DEFAULT_DIT_MODEL;
  const taskType = params.taskType === 'audio2audio' ? 'cover' : (params.taskType || 'text2music');
  const body: Record<string, unknown> = {
    model,
    prompt: params.customMode ? params.style : (params.songDescription || params.style),
    lyrics: params.instrumental ? '[Instrumental]' : (params.lyrics || ''),
    task_type: taskType,
    thinking: params.thinking ?? false,
    use_format: params.enhance ?? false,
    is_format_caption: params.isFormatCaption ?? false,
    vocal_language: params.instrumental ? 'unknown' : (params.vocalLanguage || 'en'),
    audio_format: params.audioFormat || 'mp3',
    // Leave duration absent for ACE-Step's supported automatic duration behavior.
    inference_steps: Math.floor(numberInRange(params.inferenceSteps, 8, 1, isTurboModel(model) ? 8 : 200)),
    guidance_scale: isTurboModel(model) ? 1 : numberInRange(params.guidanceScale, 7, 1, 15),
    batch_size: Math.floor(numberInRange(params.batchSize, 1, 1, 2)),
    use_random_seed: params.randomSeed !== false,
    seed: Number.isSafeInteger(params.seed) ? params.seed : -1,
    shift: numberInRange(params.shift, 3, 1, 5),
    infer_method: params.inferMethod || 'ode',
    use_adg: params.useAdg ?? false,
    cfg_interval_start: params.cfgIntervalStart ?? 0,
    cfg_interval_end: params.cfgIntervalEnd ?? 1,
    use_tiled_decode: true,
    // Startup settings alone do not override /release_task's vllm default.
    lm_backend: 'pt',
    lm_model_path: DESKTOP_LM_MODEL,
    allow_lm_batch: false,
    lm_temperature: params.lmTemperature ?? 0.85,
    lm_cfg_scale: params.lmCfgScale ?? 2.5,
    lm_top_k: params.lmTopK ?? 0,
    lm_top_p: params.lmTopP ?? 0.9,
    lm_negative_prompt: params.lmNegativePrompt || 'NO USER INPUT',
    // These flags also permit metadata completion when thinking is off.
    use_cot_caption: params.useCotCaption ?? true,
    use_cot_language: params.useCotLanguage ?? true,
    constrained_decoding_debug: params.constrainedDecodingDebug ?? false,
  };
  if (params.duration && params.duration > 0) body.audio_duration = params.duration;
  if (params.bpm && params.bpm > 0) body.bpm = params.bpm;
  if (params.keyScale) body.key_scale = params.keyScale;
  if (params.timeSignature) body.time_signature = params.timeSignature;
  if (params.audioCodes) body.audio_code_string = params.audioCodes;
  if (params.repaintingStart !== undefined) body.repainting_start = params.repaintingStart;
  if (params.repaintingEnd !== undefined && params.repaintingEnd >= 0) body.repainting_end = params.repaintingEnd;
  if (params.audioCoverStrength !== undefined) body.audio_cover_strength = params.audioCoverStrength;
  if (params.instruction) body.instruction = params.instruction;
  if (params.trackName) body.track_name = params.trackName;
  if (params.completeTrackClasses) body.track_classes = params.completeTrackClasses;
  if (params.customTimesteps) {
    const timesteps = params.customTimesteps.split(',').map(value => Number(value.trim()));
    if (timesteps.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error('Custom timesteps must be numbers between 0 and 1');
    }
    // Upstream treats custom timesteps as overriding inference_steps.
    const steps = timesteps.length - (timesteps.at(-1) === 0 ? 1 : 0);
    if (steps < 1 || (isTurboModel(model) && steps > 8)) {
      throw new Error('Turbo/DMD custom timesteps must specify 1–8 inference steps');
    }
    body.timesteps = params.customTimesteps;
  }
  if (['cover', 'repaint', 'extract', 'lego', 'complete'].includes(taskType) && !params.sourceAudioUrl) {
    throw new Error(`${taskType} requires source audio`);
  }
  return body;
}

export async function requestEngineJson(endpoint: string, body?: unknown, timeoutMs = 30_000): Promise<any> {
  const response = await fetch(new URL(endpoint, config.acestep.apiUrl), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`ACE-Step ${endpoint} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || (data.code !== undefined && data.code !== 200)) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data.error || text);
    throw new Error(`ACE-Step ${endpoint} failed (HTTP ${response.status}): ${detail}`);
  }
  return data;
}

export function parseTaskResult(task: any): any[] {
  if (!task || ![0, 1, 2].includes(Number(task.status))) throw new Error('ACE-Step returned an invalid task status');
  let result: any;
  try {
    result = typeof task.result === 'string' ? JSON.parse(task.result) : task.result;
  } catch {
    throw new Error(task.error || 'ACE-Step returned an invalid task result');
  }
  const items = Array.isArray(result) ? result : (result ? [result] : []);
  const failure = items.find(item => Number(item?.status) === 2 || item?.error);
  if (Number(task.status) === 2 || failure) {
    throw new Error(task.error || failure?.error || items.find(item => item?.error)?.error || task.progress_text || 'ACE-Step generation failed');
  }
  return items;
}

export function engineAudioUrl(file: string): URL {
  const base = new URL(config.acestep.apiUrl);
  const url = new URL(file, base);
  if (url.origin !== base.origin || url.pathname !== '/v1/audio' || !url.searchParams.get('path')) {
    throw new Error('ACE-Step returned an unexpected audio URL');
  }
  return url;
}

export function audioExtension(url: URL, fallback = 'mp3'): string {
  const extension = path.extname(url.searchParams.get('path') || '').toLowerCase();
  return ['.mp3', '.flac', '.wav', '.ogg', '.opus', '.aac'].includes(extension) ? extension : `.${fallback}`;
}
