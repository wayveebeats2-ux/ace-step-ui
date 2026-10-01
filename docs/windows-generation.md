# Windows portable generation audit

The portable launcher starts ACE-Step on 127.0.0.1:8001, the Node backend on 3001, and Vite on 3000, then opens WebView2. Extract the UI ZIP, put the official `ACE-Step-1.5` portable folder beside `ACE-Step UI.exe`, and double-click the EXE. Node is bundled; the engine supplies embedded Python and checkpoints. WebView2 Runtime must be installed. First model downloads require internet access. Logs are in the extracted UI folder's `logs` directory.

## Source audited

Engine source: `ace-step/ACE-Step-1.5` revision `ca1e85fe9430179831e6bc6be790c332190a3866`. This source checkout was inspected without installing models. An older official portable engine may implement different behavior; record its version when testing.

The request builder follows `acestep/api/http/release_task_models.py` and the release-task parser. Its regression payload was also validated using the actual upstream Pydantic request model, with no unknown fields.

## RTX 3050 / 8 GB profile

| Setting | Applied value | Reason / source |
| --- | --- | --- |
| `ACESTEP_CONFIG_PATH` | `acestep-v15-turbo` | Primary DiT; additional startup model slots are empty. |
| `ACESTEP_LM_BACKEND` | `pt` | `api/startup_llm_init.py`; avoids persistent nano-vLLM KV-cache allocation. |
| `ACESTEP_LM_MODEL_PATH` | `acestep-5Hz-lm-0.6B` | Tier3-sized LM. |
| `ACESTEP_INIT_LLM` | `auto` | Engine-managed startup initialization. |
| `ACESTEP_OFFLOAD_TO_CPU` | `true` | Supported component offload in `api/startup_model_init.py`. |
| `ACESTEP_OFFLOAD_DIT_TO_CPU` | `true` | REST startup otherwise defaults this to false, despite tier3 recommending true. |
| `ACESTEP_LM_OFFLOAD_TO_CPU` | `true` | PT inference returns LM weights to CPU after each inference context. |
| `ACESTEP_VAE_ON_CPU` | `false` | Prefer GPU VAE decoding when memory permits; engine retains its low-memory fallback. |

Every `/release_task` also sends `lm_backend: "pt"`, `lm_model_path: "acestep-5Hz-lm-0.6B"`, and `allow_lm_batch: false`. Startup alone does not override the API request's vLLM default. The audited PT loader does not silently fall back to vLLM. However, upstream readiness can reuse an already initialized LM without checking the requested backend. The launcher therefore refuses occupied service ports, avoiding reuse of an unrelated pre-existing engine. If connecting a separately started engine, configure and restart it explicitly with the same PT profile; request fields alone cannot prove its loaded backend.

`llm_inference.py` releases/offloads the PT LM after its inference context. The DiT model context in `service_generate_execute.py` ends before VAE decoding, so explicit DiT offload makes its weights reclaimable at that boundary. This is the key change for the reported 0.36 GB free VRAM at VAE decode.

`generate_music_decode.py` can choose CPU fallback below approximately 0.5 GB effective free VRAM. `memory_utils.py` supports `ACESTEP_VAE_DECODE_CHUNK_SIZE`, but its adaptive sizing already selects smaller chunks on an 8 GB GPU. Requests retain `use_tiled_decode: true`; no fixed chunk override is added. Offloading involves CPU/RAM transfers and must be benchmarked on the actual machine.

Tier3 recommends quantization, but the audited REST startup does not pass a quantization option to initialization. Adding an invented `ACESTEP_QUANTIZATION` variable would have no effect. Engine-level support is a separate follow-up if offloading remains insufficient. No engine source is patched by this UI change.

## REST lifecycle and behavior

Normal generation uses `/release_task`, `/query_result`, and same-origin `/v1/audio` downloads. Health uses `/health`. Model selection uses `/v1/models` and submits directly for an already-loaded model. Primary-slot switching uses `/v1/init` only when advertised by the engine OpenAPI schema. Older portable engines do not provide that endpoint; unknown inventory responses are passed to `/release_task` for validation rather than forcing initialization. Turbo/DMD requests are capped at eight steps, including custom timestep overrides; turbo guidance is fixed at one. The desktop UI defaults to eight steps and caps batches at two.

Thinking OFF disables LM audio-code generation; upstream may still use the LM to fill missing automatic metadata. Enhance is forwarded as `use_format`; Enhance OFF also forces `use_cot_caption: false` so automatic metadata processing cannot replace the submitted caption. Thinking remains an independent control for LM audio-code generation. Automatic duration is left to ACE-Step rather than silently forced to 60 seconds. Random/fixed seeds, CoT flags, track fields, and source/reference paths use the current API field names. Uploaded source/reference audio is staged under the OS temporary directory because current ACE-Step rejects arbitrary absolute input paths.

Terminal task errors are extracted from nested JSON results and immediately end polling. The server owns a 15-minute generation deadline. Completed audio is downloaded once, preserving the returned WAV/FLAC/MP3 extension, and saved to SQLite/library independently of browser polling. Restarted backend jobs are marked interrupted rather than remaining queued forever. A UI disconnect does not stop server-side completion; engine cancellation on timeout is not implemented.

Obsolete health probes, generation Gradio fallbacks, and Python generation/formatting subprocess fallbacks were removed. Gradio remains a dependency for existing auxiliary training/LoRA/random-description routes; those features need separate REST compatibility work.

## Verification performed in the Linux cloud environment

- Frontend production build and repository TypeScript check passed.
- Backend TypeScript build passed.
- Sixteen backend tests passed, including an isolated backend process against a simulated API with upstream-shaped responses.
- Integration tests cover PT payloads, durable library completion without status polling, WAV playback/range requests, one-copy downloads, immediate nested KV-cache failure, source/reference staging cleanup, and REST formatting errors.
- The real upstream Pydantic schema accepted all 32 fields in the basic regression payload.

These tests validate application transport and persistence, not generated music or GPU memory behavior. The Windows launcher build, WebView2 startup, real model loading, LM/DiT/VAE timing, and RTX 3050 VRAM usage remain unverified here. Windows CI runs the tests and type checks before packaging.

## Required Windows regression

Close other ACE-Step instances and GPU-heavy apps, extract a newly built portable package, and launch `ACE-Step UI.exe`. Configure:

- Model: `acestep-v15-turbo`; LM: PT / 0.6B.
- Duration: 30 seconds; Instrumental ON; Batch size 1; Steps 8.
- Thinking OFF; Enhance OFF; BPM/key/time signature Auto.

Prompt:

> Atmospheric late-night electronic instrumental, deep warm bass, crisp punchy drums, dreamy synth pads, subtle melodic arpeggios, modern polished production, cinematic and slightly dark, smooth progression with a strong groove.

Inspect `logs/backend.log` for the submitted PT/0.6B profile, engine task ID, stages, and completion or exact failure. Inspect `logs/ace-step.log` for the engine's actual PyTorch LM initialization, offload behavior, and VAE decode timing. The launcher's profile line expresses requested settings; the engine's own initialization messages establish what loaded. Confirm there are no nano-vLLM initialization/KV-cache messages, audio appears in the library and plays, and a second generation works without duplicate model residency. Record LM/DiT/VAE times and peak/free VRAM; the synthetic tests cannot establish these.

## Prioritized follow-up

1. Run that Windows/RTX regression and measure VAE timing and VRAM before changing chunk sizes or quantization.
2. Migrate or explicitly disable auxiliary Gradio-only features in the REST desktop profile.
3. Address existing local-file deletion/path validation and library privacy defaults, especially before enabling network access beyond localhost.
4. Package frontend styling/assets locally for reliable offline use; audit dependency advisories and native backend dependencies in the Windows ZIP.
5. Add engine cancellation and recovery/reconciliation for backend restarts or inference timeouts.

## Portable engine compatibility fix

The uploaded Windows logs showed successful PT/0.6B initialization, followed by `/v1/init` HTTP 404 before any `/release_task` submission. The exact `/v1/models` response was not included in those logs. Compatibility tests now cover older/list-shaped and unknown inventories with `/v1/init` unavailable, clear errors for unsupported model switching, and advertised initialization on newer engines. This fixes the premature initialization failure; it does not establish real GPU/VAE generation success.

The next uploaded logs identified the older OpenRouter inventory: `name` is a display label such as `ACE-Step acestep-v15-turbo`, while `id` is `acestep/acestep-v15-turbo`. Model matching now prefers the ID, removes the supported provider prefix, and normalizes display labels when no ID is present. The frontend model inventory uses the same normalization. Tests include the actual upstream OpenRouter-shaped response with both fields.

## Prompt preservation

The successful Windows run submitted `90s hip hop`, duration 30 seconds, Thinking OFF, and Enhance OFF. The PT LM nevertheless generated a caption beginning with acoustic guitar, which became the DiT input because caption CoT was enabled by default. Caption rewriting now requires Enhance ON; the advanced caption checkbox is disabled while Enhance is OFF. Automatic metadata remains available. Windows logs establish successful LM offloading, DiT diffusion, VAE decoding, and audio download for that 30-second run (about 32 seconds end to end). The new prompt-preservation behavior still needs a Windows inference check; unit/integration tests verify its request settings.
