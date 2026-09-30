import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const prompt = 'Atmospheric late-night electronic instrumental, deep warm bass, crisp punchy drums, dreamy synth pads, subtle melodic arpeggios, modern polished production, cinematic and slightly dark, smooth progression with a strong groove.';
let engine: Server, backend: ChildProcess, directory: string, base: string, token: string;
let engineBase: string, lastPayload: any, activeModel = 'acestep-v15-turbo', healthReady = true;
let lastTask = '', taskCount = 0, queryCount = 0, downloadCount = 0, initCount = 0;
const tasks = new Map<string, any>();
let backendLog = '';
// One second PCM silence: tests transport/decoding only, not model inference quality.
const wave = Buffer.alloc(44 + 16000);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(16000, 40);

async function api(endpoint: string, body?: unknown, authenticated = true): Promise<any> {
  const response = await fetch(base + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function waitFor(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`${description}\nBackend log:\n${backendLog}`);
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ace-ui-regression-'));
  engine = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(request.url!, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/health') { response.end(JSON.stringify({ code: 200, data: { status: 'ok', models_initialized: healthReady } })); return; }
    if (url.pathname === '/v1/models') { response.end(JSON.stringify({ code: 200, data: { default_model: activeModel, models: [{ name: activeModel, is_default: true }] } })); return; }
    if (url.pathname === '/v1/init') { activeModel = body.model; initCount++; response.end(JSON.stringify({ code: 200, data: { loaded_model: activeModel } })); return; }
    if (url.pathname === '/release_task') {
      lastPayload = body; lastTask = `task-${++taskCount}`; tasks.set(lastTask, body);
      response.end(JSON.stringify({ code: 200, data: { task_id: lastTask } })); return;
    }
    if (url.pathname === '/query_result') {
      queryCount++; const id = body.task_id_list[0]; const params = tasks.get(id);
      const error = params.prompt === 'FAIL KV' ? 'RuntimeError: Insufficient KV cache to schedule sequence' : null;
      const result = error ? [{ status: 2, error }] : [{ status: 1, file: '/v1/audio?path=C%3A%5Ctemp%5Cregression.wav', metas: { duration: 30, bpm: 108, keyscale: 'C minor', timesignature: '4' } }];
      response.end(JSON.stringify({ code: 200, data: [{ task_id: id, status: error ? 2 : 1, result: JSON.stringify(result), progress_text: error ? 'Failed' : 'VAE decode complete' }] })); return;
    }
    if (url.pathname === '/v1/audio') { downloadCount++; response.setHeader('Content-Type', 'audio/wav'); response.end(wave); return; }
    if (url.pathname === '/format_input') { response.statusCode = 503; response.end(JSON.stringify({ code: 503, error: 'Engine temporarily unavailable' })); return; }
    response.statusCode = 404; response.end('{}');
  });
  engine.listen(0, '127.0.0.1'); await once(engine, 'listening');
  engineBase = `http://127.0.0.1:${(engine.address() as any).port}`;
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as any).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(port), ACESTEP_API_URL: engineBase,
      DATABASE_PATH: path.join(directory, 'audit.db'), AUDIO_DIR: path.join(directory, 'audio'),
      DATASETS_DIR: path.join(directory, 'datasets'), DATASETS_UPLOADS_DIR: path.join(directory, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout!.on('data', data => { backendLog += data.toString(); });
  backend.stderr!.on('data', data => { backendLog += data.toString(); });
  await waitFor(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'Backend startup');
  const login = await api('/api/auth/setup', { username: 'GenerationRegression' }, false); token = login.token;
});

after(async () => {
  if (backend && backend.exitCode === null) { const exited = once(backend, 'exit'); backend.kill('SIGTERM'); await exited; }
  if (engine) await new Promise<void>(resolve => engine.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('REST health uses /health and rejects an uninitialized model', async () => {
  assert.equal((await api('/api/generate/health')).healthy, true);
  healthReady = false; assert.equal((await api('/api/generate/health')).healthy, false); healthReady = true;
});

test('full 30s request completes into the library without status polling, plays as WAV and creates one file', async () => {
  const job = await api('/api/generate', { customMode: true, style: prompt, lyrics: '', title: 'Regression', instrumental: true, duration: 30, batchSize: 1, inferenceSteps: 12, thinking: false, enhance: false, lmBackend: 'vllm' });
  await waitFor(async () => (await api('/api/generate/history')).jobs.find((item: any) => item.id === job.jobId)?.status === 'succeeded', 'Durable completion without status GET');
  assert.equal(lastPayload.lm_backend, 'pt'); assert.equal(lastPayload.lm_model_path, 'acestep-5Hz-lm-0.6B');
  assert.equal(lastPayload.allow_lm_batch, false); assert.equal(lastPayload.inference_steps, 8);
  assert.equal(lastPayload.thinking, false); assert.equal(lastPayload.use_format, false);
  const first = await api(`/api/generate/status/${job.jobId}`), second = await api(`/api/generate/status/${job.jobId}`);
  assert.equal(first.status, 'succeeded'); assert.deepEqual(first.result, second.result);
  const songs = (await api('/api/songs')).songs; assert.equal(songs.length, 1);
  assert.equal(songs[0].audio_url, first.result.audioUrls[0]); assert.equal(songs[0].bpm, 108);
  assert.equal(songs[0].duration, 30); assert.equal(songs[0].key_scale, 'C minor');
  const audio = await fetch(base + songs[0].audio_url); assert.equal(audio.status, 200);
  assert.match(audio.headers.get('content-type')!, /audio\/wav/); assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wave);
  const range = await fetch(base + songs[0].audio_url, { headers: { Range: 'bytes=0-43' } }); assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 44);
  assert.equal((await readdir(path.join(directory, 'audio'))).length, 1);
  assert.equal(downloadCount, 1); assert.equal(initCount, 0);
});

test('nested KV-cache failure stops engine polling after one terminal result and reaches the UI', async () => {
  const beforeQueries = queryCount;
  const job = await api('/api/generate', { customMode: true, style: 'FAIL KV', lyrics: '', instrumental: true });
  await waitFor(async () => (await api('/api/generate/history')).jobs.find((item: any) => item.id === job.jobId)?.status === 'failed', 'Terminal failure');
  const status = await api(`/api/generate/status/${job.jobId}`); assert.equal(status.status, 'failed');
  assert.match(status.error, /Insufficient KV cache/);
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(queryCount - beforeQueries, 1);
  assert.equal((await api('/api/songs')).songs.length, 1);
});

test('cover/reference paths are staged in system temp and cleaned after completion', async () => {
  const form = new FormData(); form.append('audio', new Blob([wave], { type: 'audio/wav' }), 'source.wav');
  const upload = await fetch(base + '/api/generate/upload-audio', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(upload.status, 200); const source = (await upload.json() as any).url;
  const job = await api('/api/generate', { customMode: true, style: 'Cover regression', lyrics: '', instrumental: true, taskType: 'cover', sourceAudioUrl: source, referenceAudioUrl: source, enhance: true });
  await waitFor(async () => (await api('/api/generate/history')).jobs.find((item: any) => item.id === job.jobId)?.status === 'succeeded', 'Cover staging');
  assert.equal(lastPayload.use_format, true);
  assert.ok(lastPayload.src_audio_path.startsWith(os.tmpdir()));
  await assert.rejects(readFile(lastPayload.src_audio_path), /ENOENT/);
  await assert.rejects(readFile(lastPayload.reference_audio_path), /ENOENT/);
});

test('format failures return useful REST errors without starting a second Python model', async () => {
  const response = await fetch(base + '/api/generate/format', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ caption: 'Format test' }) });
  assert.equal(response.status, 500); assert.match((await response.json() as any).error, /Engine temporarily unavailable/);
  assert.doesNotMatch(backendLog, /Fallback spawn|falling back to Python/);
});
