import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioExtension, buildReleaseTaskPayload, engineAudioUrl, parseTaskResult } from '../src/services/acestep-rest.js';
import type { GenerationParams } from '../src/services/acestep-types.js';

export const regressionPrompt = 'Atmospheric late-night electronic instrumental, deep warm bass, crisp punchy drums, dreamy synth pads, subtle melodic arpeggios, modern polished production, cinematic and slightly dark, smooth progression with a strong groove.';
const params: GenerationParams = { customMode: true, lyrics: '', style: regressionPrompt, title: 'Regression', instrumental: true, duration: 30, batchSize: 1, inferenceSteps: 8, thinking: false, enhance: false };

test('30 second instrumental regression pins PT/0.6B on every request, including stale vLLM UI settings', () => {
  const payload = buildReleaseTaskPayload({ ...params, lmBackend: 'vllm', lmModel: 'acestep-5Hz-lm-4B', allowLmBatch: true });
  assert.equal(payload.prompt, regressionPrompt);
  assert.equal(payload.lyrics, '[Instrumental]');
  assert.equal(payload.model, 'acestep-v15-turbo');
  assert.equal(payload.lm_backend, 'pt');
  assert.equal(payload.lm_model_path, 'acestep-5Hz-lm-0.6B');
  assert.equal(payload.allow_lm_batch, false);
  assert.equal(payload.audio_duration, 30);
  assert.equal(payload.batch_size, 1);
  assert.equal(payload.inference_steps, 8);
  assert.equal(payload.guidance_scale, 1);
  assert.equal(payload.thinking, false);
  assert.equal(payload.use_format, false);
  assert.equal(payload.use_tiled_decode, true);
  assert.equal(payload.use_cot_caption, true);
  assert.equal(payload.use_cot_language, true);
  assert.equal('bpm' in payload, false);
  assert.equal('key_scale' in payload, false);
  assert.equal('time_signature' in payload, false);
});

test('turbo steps are bounded, while base/SFT inference settings remain usable', () => {
  assert.equal(buildReleaseTaskPayload({ ...params, inferenceSteps: 12 }).inference_steps, 8);
  assert.equal(buildReleaseTaskPayload({ ...params, inferenceSteps: NaN }).inference_steps, 8);
  assert.equal(buildReleaseTaskPayload({ ...params, ditModel: 'acestep-v15-dmd', inferenceSteps: 20 }).inference_steps, 8);
  const base = buildReleaseTaskPayload({ ...params, ditModel: 'acestep-v15-base', inferenceSteps: 32, guidanceScale: 9 });
  assert.equal(base.inference_steps, 32);
  assert.equal(base.guidance_scale, 9);
  assert.throws(() => buildReleaseTaskPayload({ ...params, customTimesteps: '1,.9,.8,.7,.6,.5,.4,.3,.2,0' }), /1–8/);
  assert.throws(() => buildReleaseTaskPayload({ ...params, customTimesteps: 'garbage' }), /between 0 and 1/);
});

test('enhance, explicit metadata, deterministic seed, track conditioning and auto duration map to API fields', () => {
  const payload = buildReleaseTaskPayload({ ...params, duration: -1, enhance: true, randomSeed: false, seed: 42, bpm: 120, keyScale: 'C minor', timeSignature: '4', isFormatCaption: true, useCotCaption: false, useCotLanguage: false, trackName: 'drums', completeTrackClasses: ['bass'] });
  assert.equal('audio_duration' in payload, false);
  assert.equal(payload.use_format, true);
  assert.equal(payload.is_format_caption, true);
  assert.equal(payload.seed, 42);
  assert.equal(payload.use_random_seed, false);
  assert.equal(payload.bpm, 120);
  assert.equal(payload.key_scale, 'C minor');
  assert.equal(payload.time_signature, '4');
  assert.equal(payload.use_cot_caption, false);
  assert.equal(payload.use_cot_language, false);
  assert.equal(payload.track_name, 'drums');
  assert.deepEqual(payload.track_classes, ['bass']);
  assert.throws(() => buildReleaseTaskPayload({ ...params, taskType: 'cover' }), /requires source audio/);
});

test('terminal engine failure exposes the nested CUDA/KV-cache error without relying on task.error', () => {
  assert.throws(() => parseTaskResult({ status: 2, result: JSON.stringify([{ status: 2, error: 'RuntimeError: Insufficient KV cache to schedule sequence' }]) }), /Insufficient KV cache/);
  assert.throws(() => parseTaskResult({ status: 0, result: [{ status: 2, error: 'CUDA out of memory' }] }), /CUDA out of memory/);
  assert.deepEqual(parseTaskResult({ status: 0, result: '[]' }), []);
});

test('encoded /v1/audio paths preserve WAV/FLAC extensions and reject foreign URLs', () => {
  const wav = engineAudioUrl('/v1/audio?path=C%3A%5Ctemp%5Cclip.wav');
  assert.equal(audioExtension(wav), '.wav');
  assert.equal(audioExtension(engineAudioUrl('/v1/audio?path=%2Ftmp%2Fa.flac')), '.flac');
  assert.throws(() => engineAudioUrl('https://example.com/v1/audio?path=test.mp3'), /unexpected audio URL/);
  assert.throws(() => engineAudioUrl('/etc/passwd'), /unexpected audio URL/);
});
