# LLM tutor: where the compute goes, and how to make it affordable

Research for the optional tutor discussed for the educational version (#42). Nothing in the dashboard or
the Python port changes here. Written 2026-10-06/07 (US Arizona time / UTC); every quota, version and price
below was checked on those dates and will drift.

**Labels.** Every claim carries one:

- **[M]** measured here, on the machine in section 2, with the harness in section 9;
- **[V]** verified in a primary source (linked) or with our own unauthenticated `curl`;
- **[E]** estimate (arithmetic or inference from the sources);
- **[U]** untested idea.

## Summary

- **Quality decides, not speed.** Each model got six tutor questions with the right trace and card in the
  prompt (3.6). Five of eight models, from 0.35B to 1.2B, got almost everything wrong (0.5–1 of 12).
  Qwen3.5-0.8B scored 6, Qwen3.5-2B 7.5 and Qwen3.5-4B 11. Every model under 4B endorsed or half-endorsed a student's wrong explanation.
- **Not a runtime or precision problem** (11, added after review). The same 0.8B model in WebLLM and llama.cpp,
  and at fp16 and 8-bit, scored 3–6 of 12, like the 4-bit original. Those runtimes did make follow-up questions
  5–10× cheaper, and llama.cpp's CPU path is 5–10× faster than ONNX Runtime's. The route to a phone tier is a
  small model fine-tuned on gaitscope questions (11.5), trained on code-generated answers: Anthropic's terms
  forbid Claude-written training targets.
- **Where the cost goes** (3.1):
  - **Laptops with WebGPU**: after a one-off download, a question costs 1–4 s with a sub-1B model and
    5–15 s with the 4B model on this laptop's integrated GPU.
  - **Phones**: reading the prompt costs as much as writing the answer, because phone browsers prefill at
    only 31–135 tokens/s.
  - **The CPU path**: on GitHub Pages it gets one thread and decodes 1.4 tokens/s, and most current exports
    don't run there at all.
- **The export matters as much as the model** (3.3). Exports without `num_logits_to_keep` used 3–9 GB with
  2,000-token prompts; those with it used 1.2–1.8 GB.
- **Recommended design** (section 7):
  - **Tier 0 for everyone, at once:** templates over a code-built trace, 25–55 reviewed cards picked by
    rules, rule-based checks of the student's own explanation, an **Ask your assistant** hand-off (ASU's
    ChatGPT Edu, Gemini and Copilot are FERPA-approved) and an **Open in Colab / Kaggle** notebook.
    About 20 KB.
  - **An opt-in local model only on capable laptops:** Qwen3.5-4B "-ONNX-OPT", 2.8 GB, WebGPU, about
    16 GB of memory. A number guard checks its answers, and it never judges explanations.
  - **No model on phones or CPU-only machines.**
- **The owner's ideas** (4.2):
  - limiting the input: adopt;
  - predefined Markdown: adopt (it becomes the base tier);
  - batches: reject as a saving;
  - choosing models: adopt, but test answers first;
  - RAG: adopt, small (one card by rule, BM25, no embeddings).
- **The brief's targets** (3.8):
  - first words in ~3 s: met by templates everywhere, not by any model good enough to explain;
  - a short answer in ~15 s: met on laptops with ~400-token prompts;
  - under 500 MB on phones: met by not downloading a model there.
- **Hosting** (1): GitHub Pages can't send COOP/COEP, and nothing recommended here needs them. "Enforce
  HTTPS", off when this began, is now on, which WebGPU and the #51 sensors need.
- **Remote** (6):
  - **Kaggle and Colab** are good "go deeper" notebooks under the student's account (Kaggle: 30 GPU h/week,
    phone verification), and neither may serve as a backend.
  - **No longer available:** GitHub Models (retired 2026-07-30), SageMaker Studio Lab (closed to new users)
    and free CPU Spaces (now need PRO).
- **CLAUDE.md** needs one more on-demand script and a "tutor never computes" rule (7.8).
- **Side finding** (4.5): `stepStatus()` pairs lab and algorithm steps by sample number, which mislabels most
  steps in the table and in every #53 export whenever a filter is on. This is worth its own `fix/` issue.

## 1. Starting point

### Repo state

| Issue | Expected by the brief | State on 2026-10-06 |
|---|---|---|
| #15 phyphox zip exports | done | Done: closed 2026-10-07 03:33 UTC, PR #54. |
| #36 frequency domain | done | Done: PR #46. |
| #47 Python 100 Hz check | done | Done: PR #49. |
| #48 MATLAB v7.3 via jsfive | done | Done: PR #50. |
| #51 record a walk in the browser | done | **Merged during this research**: PR #56, 2026-10-07 04:41 UTC (the issue was still open). |
| #52 resampling | done | Done: PR #55. |
| #53 exports (CSV, .mat, JSON, .npz, `--export`) | done | **Not started when this research began; merged during it**: PRs #57 and #58, 2026-10-07 05:12–05:26 UTC. The export model is `buildExport` in `src/core.js`, format version 1, described in `docs/export.md`. |
| #42 open educational tool | partly done, minus the parts that need the instructor's permission | **Not started.** Open and blocked on permission. `LICENSE` is still MIT and the README still says to check the course policy. |

How this report adapts:

- **#53 landed mid-way.** The worked-steps trace (section 7.5) is designed as a view of its export model, plus
  the few values the model doesn't hold yet.
- **#51 landed mid-way too.** Phone measurements here come from published sources and a test plan (section 8),
  not from the recorder. The recorder changes nothing in the compute analysis; it makes "the phone that
  recorded the walk is the phone asking the question" the common case.
- **#42 unsettled.** Nothing here depends on the licence. The model licences (section 5) are checked for a
  free educational page under either MIT or AGPL.

### How the live site is hosted

- **GitHub Pages, project site.** `soroushdty/gaitscope` builds from `main` / root ("legacy" build) and is
  served under the user site's custom domain: `soroushdty.github.io` has `CNAME soroushdianaty.com`, the
  apex A records point at GitHub's Pages addresses (185.199.108–111.153), and DNS is at Namecheap. [V: `gh
  api repos/soroushdty/gaitscope/pages`, `dig`]
- **Fastly in front.** Responses carry `server: GitHub.com`, `via: 1.1 varnish`, `x-served-by: cache-phx…`,
  `cache-control: max-age=600` and `access-control-allow-origin: *`. **No COOP, COEP, CSP or
  Permissions-Policy header.** [V: `curl -sI`]
- **Pages can't set custom headers.** GitHub staff, 2023: "This is a scenario we would support with custom
  headers. No ETA"; the request is still open in 2026. [V:
  [community discussion #13309](https://github.com/orgs/community/discussions/13309)] So the page can't be
  cross-origin isolated by headers; row 9 of section 4.1 covers the service-worker workaround and whether it's worth it.
- **Plain HTTP was served too, until the owner fixed it during this research.** When the research started,
  `http://soroushdianaty.com/gaitscope/` answered `200 OK` with the page, because the repo's Pages setting had
  `https_enforced: false` [V: `curl -sI`, `gh api`]. Over plain HTTP the page isn't a secure context, so WebGPU,
  the Cache API, `navigator.storage`, the clipboard and the motion sensors (#51) are all missing; #51's
  `0f0913a` added a link to the https page for that case. "Enforce HTTPS" has since been switched on: on
  2026-10-07 at 05:33 UTC, plain HTTP answered `301` and the API reported `https_enforced: true` [V].
- **Page size limits** that matter if models were ever mirrored on Pages: 1 GB per site, 100 GB/month soft
  bandwidth, 100 MiB per file in git. [V: [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
  [large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)]

## 2. What was measured, on what

### Hardware

| Part | Detail |
|---|---|
| Laptop | ASUS, AMD Ryzen AI 7 350 ("Krackan Point"): 8 cores / 16 threads, up to 5.09 GHz, AVX-512 with VNNI and BF16 |
| GPU | Integrated AMD Radeon 860M (RDNA 3.5; WebGPU reports `amd` / `rdna-3`), 512 MB VRAM carve-out plus up to 16.3 GB of shared system memory (GTT). Mesa 26.0.8 (radeonsi; Vulkan 1.4.341 instance) |
| NPU | AMD XDNA 2 (`amdxdna` driver loaded). Not reachable from a browser: WebNN is not exposed (below) |
| Memory | 30 GiB RAM, 32 GiB swap. Other apps were open (VS Code, two other Claude sessions), so 15–19 GiB was free at the start of a run |
| Disk | NVMe, 44 GB free |
| OS | Ubuntu 26.04.1 LTS (Kubuntu, KDE Plasma on Wayland), kernel 7.0.0-34 |
| Network | About 40 MB/s (≈ 320 Mbit/s) from the Hugging Face CDN, measured by downloading the eight models [M] |

There is no NVIDIA GPU, so `nvidia-smi` doesn't apply; `vulkaninfo` and `glxinfo` were used instead.

### Browsers

| Browser | Version | Used for |
|---|---|---|
| Chrome for Testing | 151.0.7922.34 (the build Playwright 1.63 installs) | Every benchmark number |
| Chromium (snap) | 154.0.8037.57 | Cross-check of one model, and the WebGPU probe |
| Firefox (snap) | 156.0.1 | Capability probe only |
| Google Chrome | not installed | — (current stable is 155, [V: chromiumdash]) |

### WebGPU on this machine, and the flags it needed

Probe: `probe.html` (section 9) in each browser, headless and headed, with four flag sets [M].

| Flags | Headless | Headed |
|---|---|---|
| none | no adapter | no adapter |
| `--enable-unsafe-webgpu` | SwiftShader (software, `isFallbackAdapter: true`, no `shader-f16`) | SwiftShader |
| `--enable-unsafe-webgpu --enable-features=Vulkan` | SwiftShader | **AMD `rdna-3`, `shader-f16`, 4 GB max buffer** |
| … plus `--enable-features=VulkanFromANGLE --use-angle=vulkan` | worked once, then no adapter | AMD `rdna-3` |

- **All WebGPU numbers below come from a headed Chrome for Testing 151 with `--enable-unsafe-webgpu
  --enable-features=Vulkan`.** Headless WebGPU was unreliable here.
- **Students won't have these flags.** Chrome enables WebGPU on Linux by default only for Intel Gen12+ (since
  144) and NVIDIA on Wayland (since 147); AMD and NVIDIA-on-X11 stay behind the flag. [V: [gpuweb
  implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status), edited 2026-10-02;
  [New in WebGPU 144](https://developer.chrome.com/blog/new-in-webgpu-144)] A student with this laptop gets
  the WebAssembly path, which section 3 measures too.
- **Firefox 156 on Linux has no `navigator.gpu`** [M]. Firefox ships WebGPU on Windows (141) and Apple-silicon
  macOS (145/147); Linux is Nightly only and Android is behind a flag. Firefox exposes no `shader-f16`, so
  `q4f16` models can't run there. [V: same wiki; MDN BCD `api/GPUSupportedFeatures`]

Other things the probe found [M]:

- `navigator.deviceMemory` reports **32** in Chromium 151 and 154 on this 30 GiB machine, so desktop Chromium
  no longer caps it at 8. (Android still caps it at 8, section 4.3.) Firefox doesn't expose it.
- WebAssembly SIMD, Memory64 and JSPI (`WebAssembly.Suspending`) are present in Chromium 151/154 and
  Firefox 156.
- Chrome's built-in Prompt API: `LanguageModel` exists in Chromium 151/154 but `availability()` is
  `"unavailable"`, because Chromium builds don't ship the Gemini Nano component. Google Chrome wasn't
  installed, so the Prompt API itself wasn't measured.
- WebNN (`navigator.ml`) is not exposed.
- Storage quota for a fresh profile: 6.4–10.7 GB.

### Software under test

- Transformers.js **4.3.1** (npm, 2026-10-06), imported as
  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js`. That file is
  self-contained; `transformers.web.min.js` has bare `onnxruntime-web` imports a no-build page can't resolve
  [M]. It pulls ONNX Runtime Web `1.31.0-dev.20260914-8d85527a0` (a dev build) and its native C++ WebGPU
  execution provider, not the older JSEP one. [V: transformers.js 4.3.1 source; ORT
  [build.ts at 8d85527a0](https://raw.githubusercontent.com/microsoft/onnxruntime/8d85527a0/js/web/script/build.ts)]
- Models came from a local mirror of the Hugging Face files (same bytes, same URL layout), so "first load"
  numbers separate the network from everything else. The network part is measured on its own (3.7).
- Greedy decoding (`do_sample: false`), thinking off (`enable_thinking: false`) for Qwen. Speed runs force a
  fixed answer length with `min_new_tokens`.

## 3. Where the cost goes

### 3.1 The split

Each cost, what it costs on each kind of device, and which knob moves it. Laptop columns are measurements on
the machine in section 2 [M]. Phone columns come from published measurements [V], mostly the LlamaWeb study
(16 devices, Chrome 147 on Android and Safari 26 on iOS, May 2026: [arXiv 2605.20706](https://arxiv.org/abs/2605.20706)
and its [benchmark dataset](https://huggingface.co/datasets/abhijitramesh/webgpu-bench-leaderboard)), or are
estimates [E]. No Transformers.js language-model measurement on a phone has been published; section 8 is
there to get one.

| Cost | Paid | Laptop, WebGPU | Laptop, WebAssembly (CPU) | Phone, WebGPU | Phone, WebAssembly | Knob that moves it |
|---|---|---|---|---|---|---|
| **Runtime download** (Transformers.js + ONNX Runtime wasm) | Once per browser | 168 KB + 5.5 MB brotli; 27 MB stored [V, M] | same | same | same | Nothing needed |
| **Model download** | Once (Safari: again after 7 days without a visit) | 238 MB–2.8 GB for the models measured (2.8 GB for the Tier L model): 6–70 s at 40 MB/s with a parallel downloader, 18.7 s for 255 MB in the browser [M] | 570 MB: Qwen3-0.6B, the only export here that runs on it (3.4) | 238–294 MB: about 12–120 s at 2.5–20 MB/s [E]; about $1.50 of US mobile data at $6/GB [V: mobile price survey, via the mobile research notes] | same | Model **and export** choice (3.3); `q4f16` vs `q4` |
| **Load from cache + create the session** | Every visit | 0.9–2.0 s for 0.35B, 1.2–1.6 s for 0.8–1.2B, 10 s for 4B [M] | 2.7–2.9 s (Qwen3-0.6B) [M]. Most current exports fail to load at all (3.4) | Not published (section 8 measures it) | — | Model size; a worker keeps the page responsive meanwhile |
| **First-question warm-up** (shader compilation) | Every load | 0.16–0.48 s [M] | — | Safari: "~1-5 seconds" on the first forward pass [V: LlamaWeb §3] | — | A one-token warm-up right after loading |
| **Reading the prompt (prefill)** | Every question | 208–1,553 tok/s for the sub-1.2B models: 0.3–2.6 s for ~550 tokens; 82 tok/s for the 4B: 6.8 s [M] | 27 tok/s on one thread (72 with 4, 93 with 8, isolated): 21 s for 559 tokens [M] | 31–135 tok/s for 0.35–0.6B models: **4–18 s for ~550 tokens** [V] | 10–30 tok/s [E]: 20–60 s | **Prompt length** (4.1, row 1); KV reuse for follow-ups; exports with `num_logits_to_keep` |
| **Writing the answer (decode)** | Every output token | 14–91 tok/s: 1.3–8.6 s for 120 tokens [M] | 1.4 tok/s on one thread (3.3 with 4): 86 s for 120 tokens [M] | 2.7–39 tok/s: **3–44 s for 120 tokens** [V] | 1–15 tok/s [E] | **Answer length**; model size |
| **Memory** | While loaded | 1.2–1.8 GB renderer + 0.8–1.7 GB GPU for exports with `num_logits_to_keep`; 3–9 GB + 3–6 GB without, at 2k-token prompts [M] | 3.9 GB renderer (Qwen3-0.6B) [M] | iOS: a tab limit somewhere between < 0.5 and 2 GB; the low-end phone cluster fitted only ≤ 0.4 GB models [V] | wasm32: 4 GB per page; 2 GB on 32-bit builds [V] | Export; prompt length; hybrid architectures (small KV cache) |
| **Battery and heat** | Per answer | n/a (on mains) | — | About 0.3–0.6% of the battery per answer; clocks halve after about 9 back-to-back runs; surfaces reach 42–48 °C [E from V] | 0.3–1.6% [E] | Shorter prompts and answers; templates first |

How the split changes:

- **Laptop with WebGPU**: the one-off download is the only cost a student notices. A question costs about
  1–4 s in total with a sub-1B model and 10–15 s with the 4B.
- **Phone with WebGPU**: per-question compute dominates, and **reading the prompt costs as much as writing
  the answer**, because phones prefill at only 31–135 tok/s in the browser, while native apps reach
  1,800–3,800 tok/s on the same class of chips [V: vendor figures for LiteRT-LM and Google AI Edge]. Prompt
  length is the main knob.
- **CPU (WebAssembly)**: everything is several times slower again (3.4), and without cross-origin isolation it
  runs on one thread.

### 3.2 Measured on this laptop, WebGPU

Batch A (section 9): every model was loaded twice (first from the local mirror, then from the browser cache),
then asked four prompt sizes × two answer lengths × two repeats. Prefill and decode are medians over all runs
except the first, which includes the warm-up. Memory is the peak over loading and generating, as a delta from
before the page loaded; "GPU" is the amdgpu GTT counter.

| Model | q4f16 MB | `num_logits_to_keep` | Load from cache (s) | … of which session | 1st question warm-up (ms) | Prefill tok/s | Decode tok/s | First token at ~560 / ~800 / ~2,100 tokens (s) | Peak renderer / GPU (GB) |
|---|---:|---|---:|---:|---:|---:|---:|---|---|
| LFM2.5-350M | 255 | yes | 0.9 | 0.8 | 162 | 1,553 | 91 | 0.3 / 0.5 / 1.3 | 1.2 / 0.8 |
| Granite-4.0-H-350M | 238 | yes | 2.0 | 1.7 | 466 | 536 | 46 | 1.1 / 1.4 / 3.1 | 1.2 / 1.7 |
| Qwen3.5-0.8B (Text) | 470 | yes | 1.6 | 1.3 | 475 | 655 | 40 | 0.9 / 1.2 / 3.4 | 1.8 / 1.5 |
| Qwen3-0.6B | 570 | no | 3.3 | 1.9 | 281 | 486 | 41 | 1.1 / 1.5 / 11.8 | 8.8 / 6.0 |
| Gemma 3 1B | 764 | no | 1.5 | 1.0 | 394 | 336 | 32 | 1.6 / 2.3 / 7.7 | 6.3 / 3.9 |
| LFM2.5-1.2B | 760 | no | 1.2 | 0.9 | 156 | 208 | 51 | 2.6 / 3.7 / 8.8 | 3.2 / 2.8 |
| Qwen3.5-2B (multimodal export) (crashed: WebGPU buffer download failed) | 1,385 | no | 3.4 | 0.8 | 813 | 8 | 20 | 71.0 / 107.7 / – | 5.2 / 4.8 |
| Qwen3.5-4B (-OPT export) | 2,802 | yes | 10.3 | 0.9 | 563 | 82 | 14 | 6.8 / 9.8 / 27.4 | 8.5 / 5.4 |

What the table shows [M]:

- **Prefill runs at a steady rate per model**, so the first token arrives in time proportional to the prompt:
  every 1,000 prompt tokens cost 0.65 s (LFM2.5-350M) to 12 s (Qwen3.5-4B) on this iGPU.
- **Decode barely depends on the prompt**; it drops by 5–15% with 2,000 tokens in the cache.
- **Loading from the cache takes 1–2 s for sub-1B models**, mostly session creation rather than reading the
  cache. Reading 2.8 GB from the Cache API for the 4B model took 9.4 s.
- **The first question after a load pays 160–480 ms extra** (warm-up).
- **Size predicts speed only roughly.** LFM2.5-350M is 3× faster than Granite-4.0-H-350M at the same size, and
  LFM2.5-1.2B decodes faster than Qwen3.5-0.8B but prefills 3× slower.
- The Qwen3-0.6B `long` figure (11.8 s) is a median of runs between 4.4 and 55 s: two of them ran while the
  laptop swapped (3.3).

### 3.3 The export matters as much as the model

Three exports used several times the memory of the others with long prompts, and one was unusable. The common
factor [M]: their ONNX graphs lack the `num_logits_to_keep` input (checked with `scripts/onnx_io.py`). Without
it, prefill computes and returns the vocabulary logits for **every** prompt token instead of the last one:
2,100 tokens × 151,936 (Qwen) × 4 bytes ≈ 1.3 GB, or × 262,144 (Gemma) ≈ 2.2 GB, before any copies
[E: arithmetic]. Transformers.js 4.3 passes `num_logits_to_keep = 1` whenever the graph accepts it [V: 4.3.0
notes, #1681].

| Export (all `onnx-community`) | `num_logits_to_keep` | Peak renderer, 2k-token prompts | Prefill tok/s |
|---|---|---:|---:|
| Qwen3.5-0.8B-Text (2026) | yes | 1.8 GB | 655 |
| Qwen3-0.6B (2025) | **no** | **8.8 GB** (the laptop swapped) | 486 |
| Gemma 3 1B (2025) | **no** | **6.3 GB** | 336 |
| Qwen3.5-2B, multimodal (2026) | **no** | 5.2 GB, then a WebGPU buffer-download failure | **8** |
| Qwen3.5-4B "-ONNX-OPT" (2026) | yes | 2.8 GB (8.5 GB while loading) | 82 |

The bigger Qwen3.5-0.8B beats the smaller Qwen3-0.6B on both speed and memory, and the 4B "-OPT" export
prefills 10× faster than the 2B plain export. The causal link is an estimate (the exports also differ in other
ways), but the pattern holds across all eight models measured, and it matters most on phones, where the memory
isn't there. **When choosing an export, prefer graphs with `num_logits_to_keep`, external data (`.onnx_data`),
and the "-OPT" variants where they exist.** The Qwen3.5-2B "-ONNX-OPT" export wasn't measured, to stay within
the download budget; by size it should land between 0.8B and 4B [E].

### 3.4 WebAssembly (the CPU path)

**Most current exports don't run on it at all** [M]. LFM2.5-350M and Qwen3.5-0.8B (`q4`) and Granite-4.0-H-350M
(`q4f16`) failed at session creation with *"Could not find an implementation for GatherBlockQuantized(1) node
with name '/model/embed_tokens…'"*, and the LFM2.5-1.2B and Gemma 3 1B files contain the same op
(`scripts/onnx_ops.py`). Their embedding table uses a quantized gather that ONNX Runtime Web 1.31-dev
implements in its WebGPU provider but not in its CPU one. Only the 2025 Qwen3-0.6B export, which uses a plain
`Gather`, ran. A CPU fallback would need its own, separately chosen export [E: whether the `q8` files avoid the
op was not tested].

Speed, with the one model that runs (Qwen3-0.6B `q4f16`, Chrome for Testing 151, same laptop) [M]:

| Model | Threads | Load (s) | First token, 47 / 559-token prompt (s) | Prefill tok/s | Decode tok/s | 64-token answer to the 559-token prompt (s) |
|---|---|---:|---|---:|---:|---:|
| Qwen3-0.6B | 1 (not isolated: what GitHub Pages gives) | 2.9 | 2.3 / 21.1 | 27 | 1.4 | 66 |
| Qwen3-0.6B | 4 (isolated, ORT default) | 2.9 | 1.1 / 7.8 | 72 | 3.3 | 28 |
| Qwen3-0.6B | 8 (isolated) | 2.7 | 0.8 / 6.0 | 93 | 3.9 | 25 |

- **Without cross-origin isolation, which is what GitHub Pages gives, ONNX Runtime runs on one thread**
  [V: ORT `backend-wasm.ts`; M: `threads: 1`]. A 64-token answer to a 559-token prompt took **66 s**.
- **With isolation** (the `/coi/` route with real COOP/COEP headers) its default of 4 threads is 2.7× faster
  at prefill and 2.4× at decode; 8 threads add another 15–30%. Still 25–28 s for that short answer.
- The RAG pass measured the same pattern with SmolLM2-360M `q4` (fp32 activations): 31 → 82 tok/s prefill and
  2.0 → 4.3 tok/s decode, 1 → 4 threads [M by the RAG pass].
- Memory: the single-file Qwen3-0.6B export took 3.9 GB in the renderer on WASM.
- **Verdict**: with ONNX Runtime, a sub-1B model writes 1.4–4 tokens per second on a 2026 laptop CPU, and phones
  are slower. The CPU path gets Tier 0 (section 7.2), and `coi-serviceworker` isn't worth adding for it.
  llama.cpp's CPU path is 5–10× faster at decoding (11.3), which changes the speed argument but not the
  quality one.
- Under COEP `require-corp`, Transformers.js and its wasm from jsDelivr and the model files loaded without
  changes [M], as the header check predicted [V: curl].

### 3.5 Follow-up questions and the `q4` fallback

**Follow-ups with a reused KV cache** (`mode=followup`): turn 1 is the `rag` prompt with a 64-token answer;
turn 2 appends that answer and a new question, once with the cache and once from scratch [M].

| Model | Turn 1 (~800 tokens) first token | Turn 2 cached: tokens prefilled, first token | Turn 2 fresh: tokens, first token | Prefix match |
|---|---:|---|---|---|
| LFM2.5-350M | 705 ms | 27 of 852, 123 ms | 852, 597 ms | 825/825 |
| LFM2.5-350M | 499 ms | 27 of 852, 57 ms | 852, 559 ms | 825/825 |
| Qwen3.5-0.8B (Text) | 1615 ms | 27 of 900, 1444 ms | 900, 1414 ms | 806/873 |
| Qwen3.5-0.8B (Text) | 1204 ms | 27 of 900, 1388 ms | 900, 1387 ms | 806/873 |
| LFM2.5-1.2B | 4421 ms | 27 of 852, 333 ms | 852, 4261 ms | 825/825 |
| LFM2.5-1.2B | 3849 ms | 27 of 852, 296 ms | 852, 4208 ms | 825/825 |
| Granite-4.0-H-350M | — | crashed: `If` node in `/model/layers.0/mamba` | — | — |

- **LFM2.5**: the follow-up prefilled only its 27 new tokens and answered 5–14× sooner.
- **Qwen3.5-0.8B: no gain.** Its chat template renders earlier turns differently from how they were generated
  (only 806 of 873 cached tokens matched the re-rendered prompt), so the reuse would also feed it a corrupted
  context. Transformers.js doesn't check the match.
- **Granite-4.0-H-350M crashed** when continuing from a cache with more than one new token (`If` node in its
  first Mamba layer).
- So: reuse the cache only for models that pass this test, and append token IDs instead of re-rendering the
  chat template.

**`q4` instead of `q4f16`** on the same GPU, for devices without `shader-f16` [M]:

| Model | dtype | Prefill tok/s | Decode tok/s | First token ~560 / ~800 / ~2,100 (s) |
|---|---|---:|---:|---|
| LFM2.5-350M | q4 | 863 | 55 | 0.6 / 0.9 / 2.4 |
| Qwen3.5-0.8B (Text) | q4 | 340 | 27 | 1.6 / 2.3 / 8.4 |

The `q4` files are 15–17% larger and about 45% slower at prefill, 35–40% slower at decode.

### 3.6 Answer quality: a first look

Speed is only worth paying for if the answers are right. Batch B asked each model six questions with the
prompt section 7.7 recommends: the rules, the summary trace and the one or two cards a rule would pick, greedy
decoding, thinking off. The questions: why the lab code finds 15 steps and Coza 12; whether a Pace of 57.26 is
normal; why VariabilitySteps is 42.40; steps or strides; **checking a student's wrong explanation** ("Coza uses
a higher threshold"); and an off-topic question about running shoes. Scored 0–2 each by the research session
against a written rubric (`results/quality-scores.md` in the lab, with every answer) [M]:

| Model | Download (q4f16) | Score /12 | What went wrong |
|---|---:|---:|---|
| LFM2.5-350M | 255 MB | 1 | Calls a Pace of 57.26 normal steps/min; endorses the student's mistake; answers the shoe question with a line copied from the trace |
| Granite-4.0-H-350M | 238 MB | 0.5 | Wrong on every question; recommends "the gaitAsymmetry 1.234 flag" as a shoe |
| Qwen3-0.6B | 570 MB | 1 | Pace "normal"; endorses the mistake; gives shoe advice |
| Gemma 3 1B | 764 MB | 1 | Rambles to the 300-token cap; uses Pace 57.26 as a cadence |
| LFM2.5-1.2B | 760 MB | 1 | Generic answers that ignore the trace ("the pace was consistent with normal walking") |
| Qwen3.5-0.8B | 470 MB | 6 | Right on Pace, mostly right on variability and strides; **invents "h = 1.5 g"** while endorsing the mistake; loops on the shoe question |
| Qwen3.5-2B | 1,385 MB | 7.5 | Right on variability (names the tied pairs) and strides; still calls Pace "normal" before contradicting itself |
| **Qwen3.5-4B** | **2,802 MB** | **11** | Both reasons for 15 vs 12, Pace vs cadence, strides; **corrects the student** ("Coza did not use a higher threshold"); declines the shoe question. Blames variability on the stop bump only |

What this means:

- **Quality climbs steeply with size, and the cut-off sits far above what fits on a phone.** Five of the eight
  models, from 0.35B to 1.2B and including the two fastest, got almost everything wrong even with the right
  card in the prompt; only the Qwen3.5 family did better. Model cards don't predict it: LFM2.5-1.2B has the
  best IFEval of the group (86.2) and scored 1.
- **Every model below 4B endorsed or half-endorsed the student's wrong explanation.** That settles the design
  of the checker: rules decide (7.7), the model at most words the result. The literature agrees: Llama-3.2-3B
  grades short answers at 30% accuracy and gave inconsistent feedback in 82% of cases
  ([Cong et al. 2026](https://arxiv.org/abs/2605.00238), [Azaiz et al. 2025](https://arxiv.org/abs/2504.01054)).
- **The number guard is needed but isn't enough.** It catches "h = 1.5 g" (invented) and "110–120 steps per
  minute" (true, but in neither the trace nor a card), not "cadence 57.26" (a real number used for the wrong
  quantity).
- **Caveats**: one greedy sample per question, one prompt format, scored by the same session that wrote the
  rubric. It's a first look, not an evaluation; the golden-question test in 7.6 should gate any model.

### 3.7 Network and browsers

- **A real first download** from huggingface.co in the browser: LFM2.5-350M (255 MB) arrived in 18.7 s
  (13.6 MB/s), against 40 MB/s for the parallel CLI downloader on the same connection; the session then took
  0.9 s. A cached reload took 0.8 s [M].
- **Chromium 154 vs Chrome for Testing 151**: the same speeds for Qwen3.5-0.8B (650–695 tok/s prefill, 34–41
  decode) [M].

### 3.8 The brief's working assumptions and targets, checked

| Assumption or target | Verdict | Evidence |
|---|---|---|
| Model downloads of roughly 0.5–2.5 GB | **Right for models worth running.** Models under 0.5 GB exist (238–294 MB) but answered almost nothing correctly; the ones that did are 1.4–2.8 GB | 3.6 [M] |
| Phones manage about 1B parameters before the tab runs out of memory | **Optimistic.** iOS Safari tabs are limited to under 0.5–2 GB; in the 16-device study the low-end cluster (iPhone 15, iPhone 17 Pro Max, Adreno 7xx, Mali, PowerVR) fitted only ≤ 0.4 GB models; a 3B WebLLM model killed the tab on iOS 26 | [V: LlamaWeb §5–6; Apple forums; web-llm #753] |
| The CPU fallback is slow | **Confirmed, and worse than expected**: 1.4 tok/s decode on one thread on a Zen 5 laptop, and the newer exports don't run on it at all | 3.4 [M] |
| Long generations drain battery and heat phones | **Heat yes, battery barely**: about 0.3–0.6% per answer, but sustained 4–8 W, clocks halve after about 9 runs, 42–48 °C surfaces | [E from V: mobile notes] |
| **First words within ~3 s** | **Met only without a model**, on every device. A model good enough to explain (Qwen3.5-4B) needs 5–10 s for a 400–800-token prompt on this iGPU, and phones prefill at 31–135 tok/s even for 0.35–0.6B models | 3.2 [M], 3.1 [V] |
| **A short complete answer within ~15 s** | **Met on laptops** with prompts kept near 400 tokens: Qwen3.5-4B ≈ 5 s to the first token + 8.6 s for 120 tokens. Not on phones with a model worth running | 3.2 [M] |
| **A first download under ~500 MB on a phone** | **Met by not downloading a model on phones**: Tier 0 needs about 20 KB | 7.2 |


## 4. Techniques, with verdicts

**Saves** names the cost from section 3: D = download, Mem = memory, TTFW = time to first word, T = total
time, B = battery and heat. **Verdict**: adopt, try (worth a prototype), or reject.

### 4.1 Catalogue

| # | Technique | Saves | Evidence | Effort | Risk or quality loss | Verdict |
|---|---|---|---|---|---|---|
| 1 | **Limit the input** (owner's idea): a trace slice instead of the full trace, one card, a short system prompt | TTFW, Mem, B | First token grows linearly with prompt length at a fixed prefill rate: LFM2.5-350M 0.3 → 1.3 s for 560 → 2,100 tokens; Qwen3.5-0.8B 0.9 → 3.4 s [M]. Phones prefill at 31–135 tok/s, so every 100 prompt tokens cost about 0.7–3 s there [V: LlamaWeb dataset, section 3.1]. Small models also use long context badly: Gemma 3 4B's effective length is under 1K tokens ([NoLiMa](https://arxiv.org/abs/2502.05167)) | Low | A needed fact left out; the prompt tells the model to say so | **Adopt.** The biggest lever on phones |
| 2 | **Serve predefined Markdown** (owner's idea): templates over the trace and reviewed cards, no model | D, Mem, TTFW, T, B: all of them | Templates written over the example trace answer "why do the counts differ", Pace vs cadence and the spectrum cross-check correctly [M by the RAG pass]. 58 check objects, the registries' taglines and 9 metric tooltips are already written and can be shown as they are | Medium: about 25–30 cards to write and review | Only foreseen questions; cards can go stale (7.6 tests that) | **Adopt.** Tier 0 for everyone, and the first answer on every tier |
| 3 | **Divide the work into batches** (owner's idea) | Nothing by itself | Splitting one task into k calls re-reads the shared context k times: checking a 5-sentence explanation sentence by sentence costs about 1,700 prefill tokens, one call with the rule findings about 610 [E by the RAG pass]. It only saves when each call needs *less* context, or when follow-ups reuse the KV cache (row 7) | — | — | **Reject as a cost saver.** Split by *question*, one short answer each, on demand; that also gives the student something to read sooner |
| 4 | **Choose models by measured criteria** (owner's idea) | D, Mem, TTFW, T, and whether the answers are right | Two findings [M]. The quality cut-off on this task sits at about 4B: 0.35–1.2B models scored 0.5–1 of 12, Qwen3.5-0.8B 6, 2B 7.5, 4B 11 (3.6), and model-card scores didn't predict it. And the export matters as much as the size: LFM2.5-350M prefills 3× faster than Qwen3-0.6B and peaks at 1.2 GB instead of 8.8 GB at 2k tokens, because exports without `num_logits_to_keep` build full-vocabulary logits for every prompt token (3.3) | Medium: a golden-question test per model (7.6) | Benchmarks on cards don't measure faithfulness to a trace | **Adopt**, with the criteria in 5.1 |
| 5 | **RAG over distilled knowledge** (owner's idea) | Makes a small model usable; costs TTFW | Each card is 150–170 tokens [M by the RAG pass]: about 0.1 s on this laptop, 1–5 s on a phone. Choosing the card by rule from what's on screen costs nothing; hand-written BM25 over 202 doc chunks takes 26 µs per query; an embedding model (23 MB, 10 ms per query) found no more than BM25 on 10 test questions [M by the RAG pass]. More passages first help and then hurt ([Jin et al.](https://arxiv.org/abs/2410.05983)) | Medium (the cards are row 2's work) | Wrong card → confident wrong answer; rules first reduces that | **Adopt, small**: one card by rule, BM25 plus aliases for free text, two cards at most. **Reject embeddings** for now |
| 6 | **Number guard**: every number in a generated answer must appear in the trace or a card, else show the template | — (protects quality) | Small models mis-copy and invent: Qwen3.5-0.8B invented "h = 1.5 g"; Qwen3.5-4B quoted "110–120 steps per minute" from general knowledge; Gemma 3 1B used a real number for the wrong quantity, which no guard catches (3.6) [M] | Low (a regex and a lookup) | Rounding variants need a tolerance (0.5%) | **Adopt.** It is how "the tutor never computes" is enforced |
| 7 | **Reuse the KV cache for follow-ups** (`DynamicCache`, Transformers.js ≥ 4.1) | TTFW for follow-ups | Depends on the model [M, section 3.5]: LFM2.5-350M and -1.2B answer a follow-up 5–14× sooner (57–333 ms instead of 0.56–4.3 s, prefilling 27 new tokens instead of 852). Qwen3.5-0.8B gains nothing, and its chat template re-renders the history differently (806 of 873 cached tokens matched), so reuse would also corrupt its context. Granite-4.0-H-350M crashes (`If` node in a Mamba layer). WebLLM and llama.cpp reuse Qwen3.5's cache correctly: ~10× and ~4.7× faster follow-ups (11.2) | Low–medium | Transformers.js doesn't check that the cached tokens match the new prompt; keep the token IDs and append, instead of re-rendering the template | **Adopt for models that pass a test** (LFM2.5 here), appending token IDs |
| 8 | **Prefill the system prompt and trace while the student types** | TTFW of the first question (hidden, not removed) | On WASM a shared prefix halved per-question time with identical output [M by the RAG pass]. On WebGPU, `DynamicCache.update()` disposes the GPU tensors it replaces, so one prefix can't serve several independent questions without a cache that pins it [V: source] | Medium | Wasted work if no question comes | **Try** for the first question only |
| 9 | **Multithreaded WebAssembly** via `coi-serviceworker` (Pages can't send COOP/COEP) | T on the CPU path | 4 threads are 2.4–2.7× faster than 1, and 8 threads add 15–30% [M, 3.4]. Even so, a 64-token answer takes 25–28 s, and most current exports don't run on WebAssembly at all. With llama.cpp's CPU path, threads are worth 3.5–4.6× (11.3) | Low–medium; one extra reload on the first visit, twice in Safari; Safari needs `require-corp` | Breaks nothing here: every external resource the page loads sends CORS and `CORP: cross-origin` [V: curl] | **Reject** for now; **adopt** if a llama.cpp CPU tier is ever built (11.3) |
| 10 | **Detect `shader-f16`; fall back to `q4`** | Avoids a hard failure | ONNX Runtime throws "requires f16 but the device does not support it" for `q4f16` on such GPUs; Transformers.js checks only for `fp16` [V: source]. Firefox exposes no `shader-f16` at all. The `q4` fallback on this GPU: LFM2.5-350M 863 / 55 tok/s instead of 1,553 / 91; Qwen3.5-0.8B 340 / 27 instead of 655 / 40 (prefill / decode) [M] | Low | `q4` files are 15–60% larger | **Adopt** |
| 11 | **Decide the tier before downloading**, and remember a crash | Avoids wasted D and crashed tabs | Pages can't read free RAM or VRAM; iOS kills the tab instead of throwing [V: section 4.3 sources]. WebLLM uses vendor + binding-size heuristics; Chrome's own Gemini Nano runs a native micro-benchmark | Low | False negatives keep capable laptops on Tier 0 | **Adopt** (7.3) |
| 12 | **Perceived speed**: show the template first, stream tokens, run the model in a worker, warm up after load, download in the background after consent | TTFW as felt; UI stays responsive | The first question after a load pays 160–480 ms of warm-up (shader compilation) on this laptop [M]; on Safari the first forward pass costs "~1-5 seconds" [V: LlamaWeb §3]. `TextStreamer` and `InterruptableStoppingCriteria` exist [V] | Low | — | **Adopt** all five |
| 13 | **Short answers**: `max_new_tokens` ≈ 120, "at most 5 sentences" | T, B | Decode is linear in answer tokens: 120 tokens take 1.3 s (LFM2.5-350M) to 3 s (Qwen3.5-0.8B) here [M], and 3–40 s on phones at 3–39 tok/s [V] | Low | Some answers need more; offer "more" | **Adopt** |
| 14 | **Compact trace**: `path: value` lines, numbers rounded as the Metrics table rounds them | TTFW | 25–38% fewer tokens than indented JSON, 6–7% fewer than minified JSON [M by the RAG pass] | Low | — | **Adopt** |
| 15 | **Thinking off** (`enable_thinking: false` for Qwen) | T | Thinking emits hundreds of tokens before the answer; Qwen3.5's small models have it off by default, Qwen3 on [V: model cards] | None | Slightly worse reasoning | **Adopt** |
| 16 | **Cache management**: `ModelRegistry.is_cached`, `clear_cache`, `navigator.storage.persist()` | D on later visits | Models live in the Cache API under `transformers-cache`; Chrome evicts best-effort storage under pressure; Safari deletes script-writable storage after 7 days without a visit unless the page is a home-screen app [V: section 4.4] | Low | Safari users may re-download weekly | **Adopt** |
| 17 | **Pin model commits** (`revision`) and the Transformers.js version | Avoids silent changes | Model repos are re-exported under the same name; 4.3.1 depends on an ONNX Runtime *dev* build [V] | Low | Upgrades become deliberate | **Adopt** |
| 18 | **Mirror the model on GitHub Pages** in ≤ 100 MB chunks | Hugging Face rate limits in class | Anonymous Hub limit: 3,000 resolver requests per 5 min per IP, and both redirect hops count; the bytes come from a CDN that isn't counted [V: [rate limits](https://huggingface.co/docs/hub/rate-limits), headers]. One load is about 10–25 requests [E]. Pages allows 1 GB per site [V], less than the 2.8 GB Tier L model | High | Commits binary weights; licence notices | **Reject**: the model doesn't fit, and an opt-in laptop download rarely hits the request limit |
| 19 | **Structured output** (Transformers.js 4.3, JSON schema / regex) for checker verdicts | Fewer malformed outputs | Experimental package, one sequence at a time [V: 4.3.0 notes] | Low–medium | Constrains form, not truth | **Try** |
| 20 | **Chrome's built-in Prompt API** (Gemini Nano) on desktop Chrome ≥ 148 | D for the site (Chrome downloads the model once, for all sites) | Shipped to web pages in 148; needs 22 GB free disk, > 4 GB VRAM or 16 GB RAM; not on Android or iOS, not in workers [V: [Chrome docs](https://developer.chrome.com/docs/ai/get-started)]. Not measured here (Chromium lacks the model) | Low–medium | Desktop Chrome only; a model Chrome picks and may change | **Try**: run the golden questions on it; if it passes, it is a Tier L without a download |
| 21 | **A 4B model on capable laptops** (Qwen3.5-4B "-OPT", 2.8 GB), opt-in | Quality: the only model here that answered reliably | 11 of 12 (3.6); 6.8 s to the first token at 573 tokens, 14 tok/s, 10 s cached load, 8.5 GB renderer peak while loading, on this iGPU [M]; faster on discrete GPUs and Apple silicon [E] | Low | A 2.8 GB download; laptops under ~16 GB can't hold it | **Adopt** as the opt-in Tier L (7.2), never as a default |
| 22 | **Lower-bit weights** (q2/q1), speculative decoding, graph capture | — | q2/q1 dtypes exist (since Transformers.js 4.1) but LlamaWeb measured q2_k 17% *slower* than q4_k_m on GPUs; Transformers.js 4.3.1 has no speculative decoding and doesn't use graph capture [V] | — | Quality loss at q2 | **Reject** for now |
| 23 | **Prompt compression** (LLMLingua-2) | TTFW | Needs an XLM-RoBERTa-large classifier, bigger than the generator [V]; the trace is generated by code and can simply be written compactly (row 14) | — | — | **Reject** |
| 24 | **Fine-tune a tiny gaitscope model** (Kaggle GPU, published on Hugging Face) | Quality per byte | Not tested; plan and costs in 11.5. Claude-written answers can't be the training targets (Anthropic's terms) [V] | High: data, training, re-training when the code changes | Drift from the code | **Try** after Tier 0 exists, since its templates are the training data (11.5) |
| 25 | **Hand the prompt to the student's own assistant** (clipboard + open the assistant) | D, Mem, T, B on the device: no model at all | Frontier-size models at no cost to the owner; ASU's ChatGPT Edu, Gemini and Copilot are FERPA-approved and don't train on prompts [V: ai.asu.edu]. No assistant documents a prefill URL, and servers reject URLs above 8–16 KB [V: probes, section 6] | Low | The student leaves the page; personal accounts have other data terms | **Adopt**: the main generation path on phones and the default "explain more" everywhere |
| 26 | **A notebook next to the analysis** (Colab / Kaggle, the student's account) | Everything on the device | 4–9B models on a free T4; about 3–8 min from click to first answer [E, section 6.3] | Medium (owner writes one notebook) | Account and phone verification (Kaggle) | **Adopt** as the "go deeper" path |

### 4.2 Verdicts on the owner's five ideas, in one line each

- **Limiting the input: adopt.** It is the cost that matters most on phones, where reading the prompt, not
  writing the answer, dominates the wait.
- **Serving predefined Markdown: adopt.** It is free on every device and becomes the base tier, not a
  fallback.
- **Dividing the work into batches: reject as a saving.** It costs more unless each piece needs less context;
  splitting by question is the useful form.
- **Choosing optimal models: adopt**, but test answers before speed: on this task nothing under about 4B
  explained reliably (3.6), and the *export* decides speed and memory as much as the model (3.3).
- **RAG over distilled knowledge: adopt, deliberately small:** one card chosen by rule, BM25 for free text, no
  embeddings.

### 4.3 What a page can learn before a download

[V: MDN browser-compat-data 8.1.4 and the sources named; versions are when support arrived]

| Signal | Chrome desktop | Chrome Android | Safari macOS / iOS | Firefox |
|---|---|---|---|---|
| `navigator.gpu.requestAdapter()` | 113 (Linux: Intel Gen12+ from 144, NVIDIA on Wayland from 147, others flag only) | 121 (Android 12+; Chromium's allowlist names ARM, Qualcomm and Intel GPUs; others such as Samsung Xclipse may need a flag, though LlamaWeb ran a Galaxy S24 with Xclipse 940) | 26 | Windows 141, Apple-silicon macOS 145/147; Linux Nightly; Android flag |
| `adapter.info` (vendor, architecture), `isFallbackAdapter` | yes (fallback flag 136) | yes | 26 (vendor `apple`, coarse architecture only) | 141, partial |
| `adapter.features.has('shader-f16')` | most GPUs (yes on this laptop [M]) | 32% of Adreno 6xx phones | 26, all iPhones | **never** |
| `navigator.deviceMemory` | yes, up to 32 [M: Chromium 151/154] | yes, **capped at 8** | — | — |
| `navigator.storage.estimate()` / `persist()` | 61 / 55 (granted silently by engagement) | same | 17 / 15.2 (granted mainly to home-screen apps) | 57 / 57 (permission prompt) |
| `navigator.connection` (`saveData`, `type`) | `effectiveType`, `saveData` | adds `type` (`cellular`) | — | — |
| `navigator.getBattery()` | 38 | 38 | — | removed in 52 |
| UA client hints (`model`, platform version) | 90 | 90 (e.g. "Pixel 9a") | — | — |

- **Never knowable**: free RAM, the tab's kill threshold, the GPU-process budget, total VRAM. A Chrome WebGPU
  engineer: exposing the heap size "won't be possible in WebGPU due to obvious privacy concerns"
  ([web-llm #209](https://github.com/mlc-ai/web-llm/issues/209)).
- **How often WebGPU actually works**: real visitors get a working adapter 73.8% of the time on Android, 85.3%
  on iOS and 60.4% in Firefox (no sample size or dates given) [V: [Web3D Survey](https://web3dsurvey.com/webgpu)].
  So Tier 0 is not a corner case. The `shader-f16` share for Adreno 6xx (32%) comes from the same survey.
- **Existing heuristics**: WebLLM's demo calls a device low-resource when `maxStorageBufferBindingSize` ≤ 128 MB
  or the vendor is `qualcomm` or `arm`; Transformers.js checks only `shader-f16`; Chrome's Gemini Nano runs a
  native micro-benchmark and refuses below 3 GB of VRAM, 50 tok/s prefill or 5 tok/s decode, and isn't offered
  on phones at all [V: source of each].

### 4.4 Storage and eviction

- **Chrome**: up to 60% of the disk per origin; best-effort data is evicted, least recently used first, when
  free space drops below min(2 GB, 10% of disk) [V: Chromium `quota_settings.cc`]. `persist()` is granted
  silently by engagement.
- **Safari 17+**: 60% of the disk per origin, but **all script-writable storage (Cache API included) is deleted
  after 7 days of Safari use without a visit**, unless the page is a home-screen web app
  [V: [WebKit 2020](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/),
  [WebKit 2023](https://webkit.org/blog/14403/updates-to-storage-policy/)]. A student who opens the dashboard
  weekly in Safari will often download the model again.
- **Firefox**: best-effort is the smaller of 10% of the disk or 10 GiB per site; `persist()` shows a prompt.
- **Large entries**: Chrome has a bug with 2 GB+ Cache Storage entries [V: [w3c/ServiceWorker#1770](https://github.com/w3c/ServiceWorker/issues/1770)].
  The Tier L export is split into chunks, and its largest file is 1.92 GiB, just under; it cached and reloaded
  fine here [M]. Check this for any new export.
- **Origin**: the cache belongs to `https://soroushdianaty.com`, so every project page on that domain shares
  the quota [E].

### 4.5 A side finding: steps are paired by sample number

`stepStatus()` in `src/core.js` lists the union of lab-code and algorithm step **sample numbers**. It is behind
the steps table, the steps CSV and, since #53, the `steps.algorithm_status` column of every export. When an algorithm's step lands a sample or two away
from the lab peak, which happens with any filter (the algorithm sees the filtered signal, the lab code the
raw one) and with the other detectors, the table shows the lab peak as "not found by …" and the algorithm's
step as a separate row. Replicating it on the synthetic demo walk [M by the RAG pass, against the pre-#53
`stepRows()`, which had the same logic]:

| Setting | Rows not marked "kept" | Real differences |
|---|---:|---:|
| Coza, no filter | 2 | 2 |
| Coza with a filter (Butterworth … median) | 9–15 | 2 |
| Threshold peaks / Peak-to-valley / Zero-crossing | 8 / 11 / 17 | — |

Pairing by time (±0.1 s) gives Coza the same 2 real differences under every filter tried. This is outside the
tutor, but the trace (7.5), the export and the table should all pair by time. Zero-crossing
needs its own rule, because its markers sit about 0.4 s before the peak. **Suggested follow-up: a separate
`fix/` issue.**

## 5. Models: criteria and a shortlist per tier

### 5.1 Criteria, in the order that eliminated candidates here

1. **Answers the tutor's questions correctly** with the trace and a card in the prompt: the golden-question
   test (7.6). This removed every model below 4B as a default (3.6). Model-card scores didn't predict it.
2. **The export runs and stays lean on the target backend**: `num_logits_to_keep` in the graph (3.3); no
   `GatherBlockQuantized` if WebAssembly is a target (3.4); `.onnx_data` external data; a "-OPT" variant where
   one exists.
3. **Fits the tier's memory and download**: renderer and GPU peaks measured in 3.2; phones under ~0.5–2 GB [V].
4. **Licence** suits a free educational page that loads weights from Hugging Face at runtime (5.3).
5. **Thinking can be switched off**, and follow-ups either reuse the cache correctly or are known not to (3.5).

### 5.2 Shortlist per tier

| Tier | Recommended | Why | Measured here | Licence |
|---|---|---|---|---|
| **Phones** (Tier 0) | **No model** | Models that fit scored 0.5–6 of 12; models that score well don't fit (7.2) | — | — |
| **CPU only** (Tier 0) | **No model** | Most current exports don't run on WebAssembly; the one that does decodes at 1.4 tok/s on one thread | 3.4 | — |
| **Laptops/desktops, WebGPU + `shader-f16`, ≥ 16 GB** (Tier L) | **1. Qwen3.5-4B "-ONNX-OPT"** (`onnx-community/Qwen3.5-4B-ONNX-OPT`, `q4f16`, 2.8 GB text-only) | 11 of 12; has `num_logits_to_keep`; thinking off via the chat template | 82 / 14 tok/s; 6.8 s to the first token at 573 tokens; 10 s cached load; 8.5 GB renderer while loading, 2.8 GB while generating | Apache-2.0 |
| | 2–5. Candidates for the golden test, not measured here (download budget): Qwen3-4B-Instruct-2507 (2.9 GB, non-thinking only), Granite-4.0-H-Micro (1.95 GB), Phi-4-mini-instruct (2.55 GB), Gemma 4 E2B (3.1 GB) | Card IFEval 83.4 (Qwen3-4B-2507) and 84.3 (Granite-H-Micro); Phi-4-mini and Gemma 4 publish other scores | — | Apache-2.0, Apache-2.0, MIT, Apache-2.0 |
| **Laptops, 8–16 GB** (L-small, experimental) | **Qwen3.5-2B "-ONNX-OPT"** (about 1.4 GB) | The plain 2B export scored 7.5 of 12 but prefilled at 8 tok/s and crashed; the "-OPT" export should fix the speed as it did for 4B [E] | Not measured | Apache-2.0 |
| **Off the page: notebook on a free T4** | Qwen3.5-4B or -9B, Qwen3-8B, Gemma 4 E4B as 4-bit GGUF (2.7–5.7 GB) | Bigger than any page can hold; same trace and card | — | Apache-2.0 |
| **Retrieval** | **No embedding model** | BM25 plus aliases found as much on 10 test questions; rules pick most cards | 4.1, row 5 | — |

**Measured and not recommended**, with the reason:

| Model (`onnx-community` unless noted) | q4f16 | Reason |
|---|---:|---|
| LFM2.5-350M | 255 MB | Fastest by far (1,553 / 91 tok/s) but 1 of 12; LFM Open License |
| Granite-4.0-H-350M | 238 MB | 0.5 of 12; follow-ups crash (Mamba layer) |
| Qwen3-0.6B (2025 export) | 570 MB | 1 of 12; no `num_logits_to_keep` (8.8 GB peak at 2k tokens) |
| Qwen3.5-0.8B-Text | 470 MB | 6 of 12 with an invented number; the best of the sub-1B models, kept as the phone re-test candidate |
| Gemma 3 1B | 764 MB | 1 of 12; no `num_logits_to_keep`; Gemma Terms of Use |
| LFM2.5-1.2B-Instruct (`LiquidAI`) | 760 MB | 1 of 12 despite IFEval 86.2; no `num_logits_to_keep` |
| Qwen3.5-2B (plain multimodal export) | 1,385 MB | 7.5 of 12, but 8 tok/s prefill and a WebGPU crash |

### 5.3 Licences

Not legal advice. gaitscope wouldn't host or bundle weights; the browser fetches them from the Hub, so
redistribution clauses bind the Hub repo, while use restrictions and notice requirements still apply to the
page [E].

| Licence | Models | What it asks of gaitscope | Fit |
|---|---|---|---|
| **Apache-2.0** | Qwen3, Qwen3.5, Granite 4.x, Gemma 4, SmolLM | Nothing for runtime loading; if weights are ever mirrored (4.1 row 18), ship the licence and NOTICE files | Best |
| **MIT** | Phi-4-mini, Phi-3.5-mini | Keep the copyright notice with copies | Fits |
| **LFM Open License v1.0** | LFM2, LFM2.5 | Commercial use only below $10M annual revenue ("Threshold"); a free class tool is fine, but it isn't an OSI licence ([LICENSE](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/blob/main/LICENSE)) | Fits; flag it if #42 wants everything OSI-licensed |
| **Gemma Terms of Use** | Gemma 3, Gemma 3n | Users bound by the Prohibited Use Policy; distributions need a NOTICE file; Google "reserves the right to restrict (remotely or otherwise) usage" ([terms](https://ai.google.dev/gemma/terms)) | Usable; Gemma 4 has the same family under Apache-2.0 |
| **Llama 3.2 Community License** | Llama 3.2 1B/3B | Show "Built with Llama", provide the agreement, follow the AUP | Avoid: obligations without a quality advantage here |

## 6. Remote environments

Two uses, checked against "Ruled out" (the owner pays nothing and handles no student data):

1. **The place the student goes.** The owner publishes a public notebook; the student opens their own copy
   under their own account, loads a dashboard export (or runs the Python port on the raw file) and asks a
   larger open model on a free GPU next to the same analysis.
2. **A backend the static page calls.** Allowed only under the student's own account, when the terms allow
   it and nothing the owner runs is in the data path.

All quotas were checked on **2026-10-06** without signing in [V unless marked]. They change often.

### 6.1 Comparison

| Environment | Quotas and limits | Account | Terms | Who holds the data | Setup | Use 1 | Use 2 |
|---|---|---|---|---|---|---|---|
| **Kaggle Notebooks** (+ Models, Learn) | 30 GPU h/week "or sometimes higher" (P100 16 GB or 2× T4); 12 h sessions; **20 min idle timeout**; ~30 GB RAM; GPU queue at peak. [Docs](https://www.kaggle.com/docs/efficient-gpu-usage), [notebooks](https://www.kaggle.com/docs/notebooks) | Kaggle account, 13+ (13–16 with parental consent); **phone number for GPU and internet** | Personal, non-commercial; AUP bans "server farming" and activity "unrelated to ML data science". [Terms](https://www.kaggle.com/terms), [AUP](https://www.kaggle.com/aup) | Kaggle (Google), student's own account | Low: Copy & Edit, verify phone once, pick "GPU T4 x2" | **Good**: best guaranteed free GPU; Qwen 3 and Gemma 3 mountable from Kaggle Models | **No** (no inbound endpoint; AUP) |
| **Google Colab** (free) | Limits unpublished and changing; at most 12 h per VM; usually a T4, not guaranteed. [FAQ](https://research.google.com/colaboratory/faq.html) | Google account | Free tier forbids web services, remote proxies and "bypassing the notebook UI to interact primarily via a web UI" [same FAQ] | Google, under **consumer terms even on an ASU account** (Colab is an "Additional Service", outside the education agreement) | Lowest: one click from GitHub | **Good**: simplest path; GPU not guaranteed | **No** (explicitly forbidden) |
| **Hugging Face Spaces, ZeroGPU** | Daily GPU: anonymous 2 min, free 5 min, PRO 40 min; hosting needs a free account ≥ 30 days old, max 2 Spaces | HF account | Gradio only | Space owner's account | High (duplicate, wait 30 days) | Weak (tens of answers a day) | Only a **student-owned** duplicate; an owner-hosted Space is ruled out |
| **HF Inference Providers + "Sign in with HF"** (OAuth PKCE) | **$0.10/month** free credit (PRO $2) | HF account, 13+, no card | OAuth for "any website or App" | HF stores no request bodies, no training; then the provider's policy | Low: one sign-in button | Usable from any notebook | **Best data and age fit**, CORS works (probed), but the quota is tiny |
| **OpenRouter `:free` models** (OAuth PKCE) | 20 req/min; **50 req/day** (1,000 after a one-time $10) | Account, **18+**, no card | PKCE made for this; docs say keep the key in the user's browser | OpenRouter stores no prompts by default; today's free endpoints are served by providers whose free tiers may train on prompts [E] | Lowest: "Connect OpenRouter" | Usable from notebooks | **Good UX**, data caveat |
| **Groq** (free plan) | e.g. 30 req/min, 1,000 req/day, 200k tokens/day per model | Account, **18+**, no card | Customer apps with end users allowed | No training; logs ≤ 30 days | Low–medium: student pastes a key (no OAuth) | Usable from notebooks | **Good**, CORS works (probed) |
| **Google AI Studio / Gemini API** (free) | Free tier exists; limits shown only in AI Studio | Google account, 18+; not EEA/UK/CH | "Never expose keys client-side in production" | **Free-tier prompts used to improve products and read by human reviewers** | Low | Usable from notebooks | Works, **poor data fit** for personal sensor data |
| **GitHub Codespaces** | 120 core-h/month (180 with the Student Developer Pack); **no GPU** | GitHub account; no card (blocked at quota) | Not for "production-facing" or serverless use | GitHub | Low–medium | **Python port only**, not an LLM | No (terms) |
| **Binder** (mybinder.org) | 1–2 GB RAM, no GPU, 10 min idle, ≤ 6 h | None | Interactive only | Federation member, destroyed after | Low (needs `binder/requirements.txt`) | **Analysis only** | No |
| **JupyterLite / Pyodide** (static, on Pages) | Runs in the tab | None | n/a | **The student's device** | Owner builds once; student clicks | **Analysis only, but on the device.** The port reproduced `tests/fixtures/expected.json` exactly under Pyodide 314.0.7 (numpy 2.4.6, scipy 1.18.0), run in Node [V: own run]; no LLM runtime in Pyodide | n/a |
| **Local Ollama / LM Studio / llama.cpp / Jan** | The student's laptop; 4B ≈ 3 GB, 8B ≈ 5 GB | None | Open source / free | **The student's device** | Medium–high: install, pull, allow our origin | n/a | **Yes in Chrome/Edge/Firefox**: Ollama refuses our origin (403) until `OLLAMA_ORIGINS=https://soroushdianaty.com` (204), then the browser's one-time local-network prompt. **Not Safari** (WebKit blocks `http://localhost` from https pages) |
| **ASU ChatGPT Edu, Gemini for Education, Copilot Chat** | Students: ChatGPT "Instant" models, upgradable by faculty request for a class | ASURITE + Duo | ASU-provided | **Under ASU's contracts; approved for FERPA data; not used for training** ([ChatGPT Edu](https://ai.asu.edu/ai-tools/chatgpt-edu)) | Very low | **Hand-off target** (paste the trace) | No API |
| **ASU Research Computing: Sol + Open OnDemand** | Class accounts: 960 GPU-minutes per student (A100/H100), 24 h jobs. [Limits](https://docs.rc.asu.edu/resource-limits) | Faculty sponsor, or a class the instructor creates | "research and learning" | ASU | Low once the class exists | **Best GPU for ASU students**, if the instructor opts in; not for the open tool | No |
| **ASU RC AI gateway** (`openai.rc.asu.edu`) | Open-weight models on ASU hardware; quotas unpublished | RC account; key from a VPN-only portal | "keep your work within ASU" | ASU; "not passed to a commercial AI provider" ([docs](https://docs.rc.asu.edu/ai/api)) | Medium–high | Via Jupyter AI on Sol | Technically yes: CORS preflight from our origin succeeds and it answers off-VPN (401 without a key) [V: probe]. ASU only; check RC policy first [U] |
| **ASU CreateAI Builder / API** | $4/month per student project; per-project budget shared by every user | ASURITE; an ASU admin must register the page's address | ASU-provided | ASU, FERPA-approved; whether a project owner can read users' queries is undocumented | High | A student can build their own project from published docs [U] | Only if the **instructor** owns the project (never the owner) |

### 6.2 Dropped under "Ruled out", and why

- **Amazon SageMaker Studio Lab**: closed to new customers since 2026-07-30. [V: [AWS](https://docs.aws.amazon.com/sagemaker/latest/dg/studio-lab-availability-change.html)]
- **GitHub Models**: fully retired on 2026-07-30. [V: [changelog](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/)]
- **HF Spaces on CPU basic (Gradio or Docker)**: creating or duplicating one now needs PRO ($9/month). [V: [Spaces overview](https://huggingface.co/docs/hub/en/spaces-overview)]
- **Anything owner-hosted** (an owner's Space or ZeroGPU Space, Cloudflare Worker, proxy, an owner key in the page, an owner-owned CreateAI project): the owner would run the data path.
- **Colab, Kaggle, Codespaces, Binder, Cloud Shell as a backend**: their terms forbid it, and none has a stable CORS endpoint.
- **Cloudflare Workers AI**: the REST API has no CORS, so it needs a Worker. A student-deployed Worker is allowed in principle but too much setup; an owner-deployed one is an owner backend.
- **Cerebras, Modal, Saturn Cloud, Together, DeepInfra, Fireworks, Chutes**: a card on file or prepaid credit.
- **NVIDIA NIM API, SambaNova** as page backends: no CORS header; NIM's free access excludes "serving real end-users"; SambaNova allows 20 requests a day.
- **OpenAI / Anthropic APIs as a free path**: paid only. They stay possible as "bring your own paid key".
- **Owner-made custom GPT or shared Claude Project**: needs a paid plan to create or share.
- **Whole prompts in a URL**: assistants' servers fail at about 8–16 KB (HuggingChat 414 at ~8.1K characters, Gemini 400 at ~16.5K) and none of ChatGPT, Claude, Gemini or Copilot documents a prefill URL. Use the clipboard (section 7.7).
- **Gemini API free tier for raw recordings**: human review and training on prompts.
- **Paperspace (8 GB M4000), Lightning AI (one-time credits, phone), CoCalc (no internet), GPT4All (unmaintained since 2025-02)**: too weak, not repeatable, or not maintained.

### 6.3 Use 1 in practice: a notebook next to the analysis

- **Click to first answer: about 3–6 min on Colab and 4–8 min on Kaggle** [E]: connect 10–60 s, install a
  runtime 0.5–2 min (e.g. llama-cpp-python's CUDA wheel), download a 4-bit 4–8B model (2.7–5 GB at
  50–200 MB/s), load onto a T4 10–30 s. Add the GPU queue and, on Kaggle, the one-time phone check. Kaggle can
  mount Qwen 3 / Gemma 3 from Kaggle Models instead of downloading.
- **Getting the code in.** `pip install git+https://github.com/soroushdty/gaitscope` **doesn't work**:
  `pyproject.toml` has `[tool.uv] package = false` and no build system. Use `git clone --depth 1` plus
  `sys.path.insert(0, "gaitscope/python")`, or fetch `python/lab_step_det.py` from
  `raw.githubusercontent.com` (public, CORS `*`). The port needs only numpy and scipy at import. [V]
- **Links**: `https://colab.research.google.com/github/soroushdty/gaitscope/blob/main/<path>.ipynb` and
  `https://www.kaggle.com/kernels/welcome?src=https://github.com/soroushdty/gaitscope/blob/main/<path>.ipynb`
  (the Kaggle import wasn't tried signed in [U]).
- **What the notebook would hold** [U]: the student's JSON or `.npz` export from #53 (the dashboard's Export…
  menu, or the Python port's `--export`), the same knowledge file, and a 4–8B model with the same system
  prompt. The simplest way to give the notebook the same trace as the page is to add the trace to the export
  as one more part (format version 2), so no Python `trace()` has to be kept in step with the JavaScript one.
- **FERPA** [E, not legal advice]: a student putting their own recording into their own account is not an ASU
  disclosure, and the owner never sees it. If a course *requires* a platform, ASU may expect a vetted one,
  which points at Sol or the ASU assistants rather than Colab.

## 7. Recommended design

### 7.1 Principles

1. **Most of the tutor is not a model.** Templates over the trace, reviewed cards and rule-based checks are
   the base layer on every device (section 4.1, row 2). They answer the foreseen questions correctly, at once,
   for about 20 KB.
2. **Generate only where generation is good enough.** On this task that means about 4B parameters (3.6). Such
   a model fits capable laptops, not phones. Everyone else gets generation from their own assistant (the
   hand-off) or a notebook, both with far bigger models at no cost to the owner.
3. **Code computes, rules decide, the model phrases.** The trace (7.5) carries every number pre-formatted. A
   number guard checks each number in a generated answer against the trace and the cards; on a miss the page
   keeps the template answer and says why. Whether a student's explanation is right is decided by rules,
   never by the model (3.6).
4. **The page decides the tier before any large download** (7.3). A download is the student's explicit
   choice, with its size shown.
5. **Small prompts.** One trace slice, one card (two at most), the question: about 400 tokens, at most about
   1,000 (sections 3 and 4.1).

### 7.2 Device tiers and what each gets

| Tier | Who (detected as in 7.3) | Gets | Downloads |
|---|---|---|---|
| **0: no model** | Everyone, at once. The only on-device tier for phones and tablets, machines without usable WebGPU (most Linux AMD laptops, Firefox, Safari < 26), and laptops with less than ~16 GB of memory | The trace walked through by templates; the card(s) for what's on screen, plus keyword search over cards; a rule-based check of the student's own explanation; **Ask your assistant** (7.7); **Open in Colab / Kaggle** (6.3) | `src/tutor.js` and the knowledge file, tens of KB |
| **L: local model, opt-in** | Laptops and desktops (not mobile) with WebGPU, `shader-f16`, ~16 GB of memory or more, and ~6 GB of storage quota free | Tier 0, plus free-form "why" answers and follow-ups, and model wording for the rule findings | **Qwen3.5-4B "-ONNX-OPT"** `q4f16`, 2.8 GB once (about 3.5 min at the 13.6 MB/s measured in a browser) |
| **L-small: experimental** | The same, with 8–16 GB | As L, once a 2B export passes the golden-question test (7.6) | Qwen3.5-2B "-ONNX-OPT", about 1.4 GB [E: not measured] |
| **Off the page** | Anyone, including every phone | **Ask your assistant** with the prepared prompt (ASU students: ChatGPT Edu, Gemini or Copilot under ASU's FERPA-approved accounts), or the notebook with a 4–9B model on a free GPU | — |

Why no model on phones, in one line each:

- **The models that fit answer wrongly.** The three under 0.6 GB scored 0.5–1 of 12 (3.6). The best sub-1B
  model (Qwen3.5-0.8B, 470 MB) scored 6, invented a threshold and endorsed the student's mistake.
- **The models that answer well don't fit.** 2B (1.4 GB) and 4B (2.8 GB) exceed the iPhone tab budget and the
  low-end Android cluster [V], and at phone prefill rates (31–135 tok/s for 0.35–0.6B, slower for 4B) a
  400-token prompt would take minutes [E].
- **The phone already has a better option**: the student's own assistant app, which the hand-off fills with
  the same trace and card the local model would get.

Revisit when a sub-1B model passes the golden questions, or when Chrome's Prompt API ships on Android
(section 10). Section 11 checked whether another runtime or precision changes this; it doesn't.

**Runtime for Tier L**: Transformers.js, which ran the 4B that scored 11. WebLLM is the candidate to replace
it, because it reuses Qwen3.5's cache for follow-ups (~10× faster) and loads less code, once it has been
measured with the 4B on more than this laptop (11.4).

Without `shader-f16` (Firefox's WebGPU, some GPUs), `q4f16` fails outright (section 4.1, row 10). The 4B
`q4` export is 3.1 GB and about 45% slower (3.5), so such machines get Tier 0 by default and the `q4` model
only on request.

### 7.3 Deciding the tier before a download

All of this is cheap and runs when the tutor panel opens [U; signals V, section 4.3]:

1. `isSecureContext`, else Tier 0 and a link to the https page, as #51's recorder already does.
2. Mobile? `navigator.userAgentData?.mobile`, else the UA string. Mobile → Tier 0.
3. `navigator.gpu?.requestAdapter()`: `null` or `info.isFallbackAdapter` → Tier 0.
4. `adapter.features.has('shader-f16')`: no → Tier 0, `q4` on request.
5. Memory: `navigator.deviceMemory` where exposed (Chromium desktop reports up to 32 [M]): ≥ 16 → L, 8 → L-small,
   less → Tier 0. Where it isn't exposed (Safari, Firefox), say what the model needs and let the student
   decide.
6. `navigator.storage.estimate()`: quota − usage must exceed about 2× the model. `connection.saveData` →
   don't offer the download unasked; `type === 'cellular'` → say the size first.
7. **A remembered failure**: before loading, the page records "loading"; if the tab dies or the GPU device is
   lost, the next visit finds the record and stays on Tier 0 (`localStorage`, wrapped in try/catch).

What a page **cannot** learn on any browser: free RAM, the tab's kill threshold, or VRAM. On iOS a failed try
kills the tab instead of throwing [V, section 4.3]. Hence step 7, and Tier 0 always shown first.

### 7.4 What loads when

| Moment | What loads | Size |
|---|---|---|
| Page load | Nothing new | 0 |
| Tutor panel opened | `src/tutor.js` (same origin) and the knowledge file; the probe of 7.3 | tens of KB |
| **Download the local tutor (2.8 GB)** pressed (Tier L only) | In a module Web Worker: Transformers.js from jsDelivr (168 KB brotli), its ONNX Runtime wasm (5.5 MB brotli), then the model files from huggingface.co at a pinned commit; `navigator.storage.persist()` requested | the model, once |
| Right after loading | A one-token warm-up generation in the worker, so shader compilation doesn't land on the first question | — |
| Panel opened on a later visit | `ModelRegistry.is_cached` → load from the Cache API in the worker | 10 s for 2.8 GB on this laptop [M] |
| **Remove the local tutor** | `ModelRegistry.clear_cache` | frees 2.8 GB |

The download can run while the student records or analyses, but only after they press the button: never as a
side effect of opening the page.

### 7.5 The worked-steps trace

A pure function in `src/core.js`, `trace(model)` (no DOM, tested in Node), builds the trace from the export
model that #53 added (`buildExport`, `docs/export.md`). It could also be written into the export as a part of
its own (6.3). Format `gaitscope-trace/0.1`:

1. **Worked steps `S1…S8` in computation order**, with stable meanings: S1 lab detection, S2 lab metrics,
   S3 filter, S4 algorithm detection, S5 algorithm metrics, S6 spectrum cross-check, S7 lab vs algorithm
   differences, S8 harmonic ratio. Cards and templates refer to paths such as `S2.pace`.
2. **Numbers pre-formatted with units**, rounded as the Metrics table rounds them. The model copies; it
   never rounds or converts.
3. **Formulas with the numbers filled in**: `60 / 1.093 = 54.9 steps/min`; `mean(intervals) / 100 =
   102.13 / 100 = 1.021 s (assumes 100 Hz)`. The model can explain arithmetic without doing any.
4. **Differences listed with reasons**, after pairing lab and algorithm steps **by time (±0.1 s), not by
   sample number** (section 4.5 explains why).
5. **1-based samples, labelled `sample_matlab`**, as in the CSV.
6. **Three views**: *full* (for the export and "walk me through everything", better served by a template),
   *summary* (the default prompt) and a *slice* per question type (a list of paths).
7. **Sent to the model as `path: value` lines**, which take 25–38% fewer tokens than indented JSON [M by the
   RAG pass; section 4.1, row 14].

Example (built with `core.js` on the synthetic demo walk, 17 lab peaks and 15 Coza steps; excerpt):

```
settings.algorithm: Coza, window 0.3 s (30 samples), h = 1, weak-peak removal on (40%)
S2.average_step_duration: mean(intervals) / 100 = 102.13 / 100 = 1.021 s (assumes 100 Hz)
S2.pace: duration × 60 = 61.27 (labelled steps/min in the script, but it is not cadence)
S2.variability: std(intervals), N−1 = 26.9 samples
S4.weak_rule: strength = peak − h; drop if strength < 40% of the median strength (5.08)
S4.weak_dropped[1]: 2.51 s, 249, 1.55
S5.cadence: 60 / 1.093 = 54.9 steps/min
S6.cadence_spectrum: 54.8 steps/min
S7.matched: 15 of 17 lab peaks, largest shift 0.02 s
S7.differences[1]: 2.50 s, 248, weak peak (dropped by Coza)
S7.differences[2]: 16.67 s, 1663, tied peak (lab code counts it twice)
```

Size [M, real tokenizers]: full trace 1,062 (Llama 3.2) – 1,325 (SmolLM2) tokens for 17 + 15 steps, growing
to about 1.5–1.9k for 30+ steps; summary 280–360; slice for "why do the counts differ?" 195–233. Qwen, Gemma
and SmolLM2 spend one token per digit, so numeric text costs them 15–25% more.

**What the export model lacks for the trace**: it already holds the settings (including `filter_resampled`), every
step's time, sample and status (including tied peaks) and the metrics with units. It doesn't hold the median
peak strength and the weak-peak cut-off, or whether the spectrum peak was clear; these are computed today but
not exported. Its step statuses also need pairing by time first (4.5).

### 7.6 The knowledge file

**Cards, one per concept.** About 25–30 for a correct minimal set, about 55 for full coverage (lab-code quirks,
the four algorithms, each filter and envelope, spectrum, sampling, units, gait terms) [E]. Each card:

```json
{ "id": "lab.pace",
  "title": "Pace in the lab code is duration × 60, not steps per minute",
  "aliases": ["pace", "cadence", "steps per minute", "steps/min"],
  "show_when": { "metric": ["pace_lab_formula", "cadence"], "trace": ["S2.pace", "S5.cadence"] },
  "body": "The lab script computes Pace = AverageStepDuration × 60 … (100–180 tokens, self-contained)",
  "check": { "must_mention": [["60 ÷", "60 /", "divide"]], "red_flags": ["pace is (the )?steps per minute"] },
  "source": "docs/algorithm.md#original-lab-code", "source_hash": "3f9c…" }
```

- **Only `title` and `body` go into a prompt**; aliases, triggers and checks stay in code. Numbers in a body are
  either code constants (w = 30, h = 1, 40%, the 0.5–3.5 Hz gait band) or clearly marked examples; numbers
  about the recording come only from the trace.
- **Where it lives**: authored as Markdown, `docs/tutor/cards.md` (one `## id` section per card, readable on
  GitHub), and generated into `src/tutor-cards.json` by `scripts/make_tutor_cards.mjs`. The JSON is
  committed, like the test fixtures, because the page has no build step.
- **Text that already exists is reused verbatim** where it fits: the `ALGORITHMS`, `FILTERS` and `ENVELOPES`
  taglines and summaries (~1k tokens), the 58 check objects and ~29 `InputError` fixes (~2.4k tokens), and the
  9 metric tooltips [M by the RAG pass].

**Keeping it in sync with the code** (`tests/tutor.test.js`, Node) [U]:

1. **The JSON is current**: regenerating from `cards.md` gives the committed file byte for byte.
2. **Sources haven't moved under the card**: each card stores a hash of the doc section it was distilled
   from. A changed section fails the test with "card `lab.pace` needs review: docs/algorithm.md §Original
   changed"; after reviewing, `make_tutor_cards.mjs --rehash` updates it.
3. **Constants match the code**: a card that states a constant lists it in an optional `facts` field (e.g.
   `"facts": {"WEAK_RATIO": 0.4}` on the weak-peak card), compared with the `core.js` export of the same name
   (`WEAK_RATIO`, `GAIT_BAND`, `ANTIALIAS`, the default window, `w`, `h`).
4. **Coverage**: every `ALGORITHMS`, `FILTERS` and `ENVELOPES` id has a card, so adding an algorithm without a
   card fails. Giving every check an `id` (today only `labRate` has one) makes "this warning → its card" an
   exact lookup too.
5. **Triggers point at real things**: every `show_when.trace` path exists in a trace built from the synthetic
   fixture.
6. **No precomputed index.** BM25 over ~55 cards builds in a few ms at runtime, so there is nothing to keep in
   sync. If embeddings are ever added, commit the vectors with the model id, its revision and the card hashes,
   and test that the hashes match.

**The golden-question test, a gate for any model** (run by hand, not in CI; it needs the model) [U]: a fixed
set of traces built from the synthetic fixtures, each with questions like the six in 3.6, a rubric per answer
(required ideas, forbidden claims such as "Pace is steps per minute") and the number guard. A model is listed in
`TUTOR_MODELS` only if it passes, and again after any change of model, export, dtype or Transformers.js
version. The lab's batch B is a first version of it.

### 7.7 Answering, step by step

1. **Map the question to an intent.** A click on a metric, check or step gives it directly; free text goes
   through the card aliases and BM25.
2. **Show the template or card answer at once**: first words in milliseconds, on every tier.
3. **Build the prompt** the same way for every generator: the system rules (≤ 150 tokens), the intent's trace
   slice, one card, the question, and the student's own text (≤ 250 tokens) when checking an explanation.
4. **Tier L**: stream the local model's answer below the template, with a Stop button
   (`InterruptableStoppingCriteria`). When it finishes, run the number guard; on a miss, collapse the model
   answer and keep the template.
5. **Ask your assistant** (every tier, and the main path on phones):
   - copy the same prompt to the clipboard (`navigator.clipboard.writeText`, which needs https and a tap), and
     on phones offer the share sheet (`navigator.share`);
   - open the chosen assistant with a short prefilled line where its URL accepts one ("I'll paste a gaitscope
     trace; explain it"), never the whole trace, because assistants' servers reject URLs above about 8–16 KB
     (section 6.2);
   - for ASU students, point at ChatGPT Edu, Gemini or Copilot, which ASU approves for FERPA data and which
     don't train on it; say plainly that a personal account has different terms
     ([ASU AI tools](https://ai.asu.edu/ai-tools)).
6. **Follow-ups.** Reuse the KV cache only for a model that passed the follow-up test of 3.5, and append token
   IDs rather than re-rendering the chat template. Qwen3.5-0.8B gained nothing from reuse here (3.5); the 4B
   wasn't tested, so assume a full prefill per follow-up (about 5 s for 400 tokens on this iGPU) until it is.
   Start a new conversation after about 1,500 tokens of history or when the recording changes.
7. **Checking a student's explanation**: rules decide. Every number must be in the trace (within 0.5%), units
   must match, each card's `must_mention` ideas must be present, and no `red_flags` misconception may match.
   The model, if any, only words feedback for the items that failed; otherwise the page shows pre-written
   lines per rule. The student's text is never rewritten.

### 7.8 The change to CLAUDE.md's external-scripts rule

Today (`main` at `e7d094a`):

> **The dashboard stays a static page** (GitHub Pages) with no build step. Its own scripts
> are `src/core.js`, `src/record.js` and `src/app.js`; `tests/ui.test.js` inlines all three. The only
> external scripts are pako (inflating compressed MAT files) and plotly.js-basic, loaded
> with the page, and jsfive (MATLAB v7.3 / HDF5, `HDF5_URL` in `src/app.js`), loaded only
> when a v7.3 file is opened. All three are pinned on jsDelivr.

Proposed:

> **The dashboard stays a static page** (GitHub Pages) with no build step. Its own scripts
> are `src/core.js`, `src/record.js`, `src/tutor.js` and `src/app.js`; `tests/ui.test.js` inlines them. The only
> external scripts are pako (inflating compressed MAT files) and plotly.js-basic, loaded with the page;
> jsfive (MATLAB v7.3 / HDF5, `HDF5_URL` in `src/app.js`), loaded only when a v7.3 file is opened; and
> Transformers.js (`TUTOR_URL` in `src/tutor.js`), loaded in a worker only after the student chooses to
> download the local tutor model. All four are pinned on jsDelivr. Transformers.js fetches the ONNX Runtime
> wasm it pins from jsDelivr, and the model files from huggingface.co at the commits pinned in
> `TUTOR_MODELS`. Nothing else is fetched, and no request carries student data.

and a new hard rule next to it:

> **The tutor never computes numbers and works without a model.** Every number it shows comes from
> `trace()` in `src/core.js` or from a card; generated answers that contain any other number are replaced by
> the template answer. Every `ALGORITHMS`, `FILTERS` and `ENVELOPES` entry has a card in `docs/tutor/cards.md`;
> `tests/tutor.test.js` fails when a card's source section changes (review the card, then run
> `node scripts/make_tutor_cards.mjs --rehash`).

### 7.9 Privacy

- **Tier 0 and Tier L run on the student's device.** The only tutor traffic is the one-off download of the
  runtime and the model, which tells jsDelivr and Hugging Face the IP address and the model name, as any CDN
  request does.
- **The hand-off** sends the prompt (trace slice, card, question) to the assistant the student picks, under
  that account's terms, and only when the student pastes it. The page never sends it anywhere itself.
- **No owner-run component is involved** in any tier, so "Ruled out" holds.

## 8. Test plan for the owner (about an hour)

Everything runs from `~/gaitscope-llm-lab` (section 9). Results land in `results/results.jsonl` (phone and
browser runs) and on the page itself; the tables below are what to write down.

### 8.1 Laptop, 15 minutes

1. `cd ~/gaitscope-llm-lab && python3 server.py --port 8790 &`
2. **Your everyday browser, no flags** (Chromium or Firefox): open `http://127.0.0.1:8790/probe.html` and
   note "WebGPU adapter". On this laptop expect none, which is what a student with the same laptop gets.
3. Same browser: `http://127.0.0.1:8790/bench.html?preset=qwen3-06b&device=wasm&prompts=q_only,short&max=64&reps=1&auto=1`
   (one thread, as on GitHub Pages), then the same path under `/coi/` (four threads). Qwen3-0.6B is the only
   model here that runs on WebAssembly (3.4).
4. Chromium with the flags: `chromium --enable-unsafe-webgpu --enable-features=Vulkan
   'http://127.0.0.1:8790/bench.html?preset=lfm25-350m&device=webgpu&source=hf&clearCache=1&auto=1'`. This one
   downloads from huggingface.co, so it measures your real first download.
5. Same Chromium: `http://127.0.0.1:8790/bench.html?preset=qwen35-4b&device=webgpu&quality=1&auto=1` (the
   Tier L model, from the local mirror). Read the six answers and compare them with 3.6.

| Run | Model load (ms) | first token, `short` (ms) | decode tok/s | Notes |
|---|---|---|---|---|
| WASM, 1 thread | | | | |
| WASM, `/coi/` (4 threads) | | | | |
| WebGPU, first download from HF | | | | download MB/s = model MB ÷ fetch s |
| WebGPU, Qwen3.5-4B quality | | | | do you agree with the scores in 3.6? |

### 8.2 Pixel 9a, 45 minutes

**Setup (10 min).** No `sudo` is needed:

1. Download Android platform-tools (the Linux zip) from
   [developer.android.com/tools/releases/platform-tools](https://developer.android.com/tools/releases/platform-tools)
   and unzip it to `~/gaitscope-llm-lab/platform-tools`.
2. On the phone: Settings → About phone → tap *Build number* 7 times; then Developer options → *USB debugging*.
3. Connect by USB, accept the prompt, then:
   `platform-tools/adb devices` and `platform-tools/adb reverse tcp:8790 tcp:8790`.
   The phone now reaches the laptop's server as `http://localhost:8790`, which counts as a secure context, so
   WebGPU works without a certificate.
4. Chrome on the phone, battery above 50%, other apps closed, screen brightness fixed.

Why `adb reverse`: no certificate to install (mkcert would need its CA on the phone), and no third party in
the path (a free tunnel would work too, but sends the pages through someone else's server). It needs a cable,
and it charges the phone, so the heat test (step 7) runs unplugged and is read off the page.

**Runs.** Open each URL in Chrome on the phone; each page posts its result to the laptop when it finishes.
Models come from huggingface.co over your Wi-Fi (`source=hf`), as they would for a student.

| Step | URL (all on `http://localhost:8790/`) | Record |
|---|---|---|
| 1 | `probe.html?send=1` | adapter vendor/architecture, `shader-f16`, `maxStorageBufferBindingSize`, `maxBufferSize`, `deviceMemory`, storage quota |
| 2 | `bench.html?preset=lfm25-350m&device=webgpu&source=hf&clearCache=1&prompts=q_only,short,rag&max=64,256&reps=1&auto=1` | download s, session s, first token per prompt, prefill and decode tok/s. This is the speed reference: the published iPhone 17 Pro Max figure for this model is 135 / 39 tok/s (LlamaWeb, GGUF) |
| 3 | the same without `clearCache=1` | cached load s |
| 4 | `bench.html?preset=qwen35-08b&device=webgpu&source=hf&clearCache=1&prompts=short,rag&max=64,256&reps=1&auto=1` | does the best sub-1B model load; first token and decode tok/s |
| 5 | `bench.html?preset=qwen35-08b&device=webgpu&source=hf&quality=1&auto=1` | read the six answers: the same as on the laptop (3.6)? |
| 6 | `bench.html?preset=lfm25-350m&device=webgpu&source=hf&mode=followup&reps=2&auto=1` | turn-2 first token, cached vs fresh |
| 7 | Open `bench.html?preset=qwen35-08b&device=webgpu&source=hf&prompts=rag&max=256&reps=10` (no `auto`), then unplug and press **Run** | battery % before and after (shown at the end of the log), decode tok/s of the 1st vs the 10th answer (throttling), how warm the phone gets. Unplugged, the result can't reach the laptop, so read it off the page |
| 8 (optional, 570 MB) | `bench.html?preset=qwen3-06b&device=wasm&source=hf&prompts=q_only,short&max=64&reps=1&auto=1` | the CPU path on a phone (the only model here that runs on WebAssembly, 3.4) |
| 9 (optional, 3 GB, Wi-Fi only) | `bench.html?preset=qwen35-4b&device=webgpu&source=hf&prompts=short&max=64&reps=1&auto=1` | does the Tier L model load at all on an 8 GB phone, or does the tab die? |
| 10 | `rt.html?preset=lfm25-350m-q4km&source=hf&clearCache=1&prompts=q_only,short,rag&max=64,256&reps=1&auto=1` | the same model in llama.cpp (section 11): speed, and memory via `phone_watch.sh` |
| 11 | `rt.html?preset=qwen35-08b-mlc&source=hf&clearCache=1&prompts=short,rag&max=64,256&reps=1&auto=1` | Qwen3.5-0.8B in WebLLM: compare with step 4 |

Optional, during steps 2–6 with the cable in: `bash scripts/phone_watch.sh > results/phone-watch.tsv` logs
battery temperature, thermal status and Chrome's memory every 2 s.

**What would change the recommendation:**

- **Step 9 loads and decodes at ≥ 5 tok/s** → an opt-in Tier L for flagship Android phones becomes worth
  testing with the golden questions.
- **Step 5 differs from the laptop's answers** → quantized kernels behave differently on this GPU; the golden
  test must run on each GPU family, not once.
- **Step 4 or 7 kills the tab** → even sub-1B models aren't safe on mid-range phones; Tier 0 stays the only
  phone tier for good.
- **Steps 2 and 4 much faster than the published phone figures** → re-check the "minutes per answer" estimate
  for 2–4B models on phones.
- **An iPhone, if one can be borrowed**: steps 1, 2 and 4 through a tunnel or mkcert (Safari has no
  `adb reverse`). Whether Transformers.js 4.3 runs on iOS Safari at all is still unknown (section 10).

## 9. The benchmark harness

It lives outside the repo, in **`~/gaitscope-llm-lab/`** on the owner's laptop (a local git repository with no
remote), because it downloads 12.7 GB of models and writes browser profiles. Its `README.md` repeats this
section.

| Path | What |
|---|---|
| `server.py` | Local server, standard library only. Serves the pages; a model mirror at `/hf/<repo>/resolve/<rev>/<file>` shaped like the Hub, so Transformers.js can use it as `env.remoteHost`; the same pages with COOP/COEP under `/coi/` (`require-corp`) and `/coic/` (`credentialless`); and `POST /result`, which appends to `results/results.jsonl`. |
| `probe.html` | What a page can learn before a download: WebGPU adapter, limits, `shader-f16`, `deviceMemory`, cores, storage quota, connection, battery, Prompt API, WebNN, Memory64, JSPI. Works on a phone; **Send to laptop** posts the result. |
| `bench.html`, `bench.js`, `prompts.js` | Loads a model with Transformers.js 4.3.1 and times import, tokenizer, model load (download vs session creation), first token, prefill and decode for four prompt sizes and two answer lengths. `mode=followup` measures KV-cache reuse; `quality=1` asks the six questions of section 3.6 and keeps the answers. Parameters are listed at the top of `bench.js`; the form sets the same ones by hand. |
| `rt.html`, `rt.js` | The same measurements with WebLLM 0.2.85 or wllama 3.8.1 (llama.cpp), for section 11; also `mode=followup`, `quality=1`, and `gpuLayers=0` for llama.cpp's CPU path. |
| `bench.mjs` | Playwright driver. Runs `bench.html` in Chromium and samples memory every 250 ms: RSS of the browser's process tree and the amdgpu GTT/VRAM counters. Appends to `results/driver.jsonl`. |
| `probe.mjs`, `scripts/flags_probe.mjs` | Which Chromium builds and flags expose WebGPU here (section 2). |
| `scripts/download_models.sh`, `download_more.sh`, `download_runtimes.sh` | Anonymous downloads (no token) into `models/hf/`: 7.1 + 1.0 + 4.6 GB. |
| `scripts/run_all.sh` | Every batch in this report: A (WebGPU matrix), A2 (two models added later), B (q4 on WebGPU, follow-ups, quality), C (WebAssembly threads), D (a real download from huggingface.co), E (Chromium 154 cross-check), F (other runtimes and precisions), G (llama.cpp's CPU path). |
| `scripts/summ.py`, `tables.py`, `answers.py` | One block per page load; the tables of section 3; the quality answers by model and batch. `results/quality-scores.md` holds the rubric and every score. |
| `scripts/onnx_io.py` | Graph inputs of an ONNX file, e.g. whether it takes `num_logits_to_keep` (section 3.3). Run with `uvx --from onnx python -I`. |
| `scripts/phone_watch.sh` | Battery %, battery temperature, Chrome memory and thermal status of an Android phone over adb, every 2 s. |

To re-run:

```bash
cd ~/gaitscope-llm-lab
npm install                          # playwright-core only; reuses the Chromium in ~/.cache/ms-playwright
bash scripts/download_models.sh      # ~7 GB, anonymous
bash scripts/download_more.sh        # ~1 GB
bash scripts/download_runtimes.sh    # ~4.6 GB, for section 11
python3 server.py --port 8790 &      # 8765 was already taken by another http.server on this laptop
bash scripts/run_all.sh A A2 B C D E F G   # the WebGPU batches open a visible Chromium window
python3 scripts/summ.py              # summary of every page load
```

Caveats:

- **Memory numbers are deltas** from a baseline taken just before each page load. RSS counts the browser's
  processes, GTT is system-wide GPU memory, and the two overlap where the GPU process maps GPU buffers. Use
  them to compare models, not as exact budgets.
- **The laptop wasn't idle**: other apps held 11–15 GB, and two runs touched swap (section 3.3). Those runs
  are marked.

## 10. Open questions, and risks that would change the recommendation

### Open questions

1. **Will a sub-1B model ever be good enough?** Not one of the six measured here (3.6). Small models are
   released monthly, so re-run the golden questions when a promising one appears. The phone tier depends on
   this, not on speed.
2. **Qwen3.5-2B "-ONNX-OPT"**: the likely L-small model for 8–16 GB laptops. Its quality should match the plain
   export's 7.5 of 12 and its speed should land between 0.8B and 4B, but neither was measured (download
   budget).
3. **Follow-ups on the 4B**: does it reuse its KV cache correctly? Qwen3.5-0.8B didn't (3.5).
4. **The Pixel 9a's real numbers** (section 8). No Transformers.js language-model measurement on any phone has
   been published.
5. **iPhone**: does Transformers.js 4.3 run on iOS Safari 26 at all? WebGPU was enabled for Safari 26 only in
   4.3.0, after earlier v4 releases failed there ([#1604](https://github.com/huggingface/transformers.js/issues/1604)).
   It matters only if question 1 changes the phone tier.
6. **Chrome's Prompt API** on the golden questions (4.1, row 20).
7. **The scores in 3.6 were given by the research session that wrote the rubric.** The owner (and ideally
   the instructor) should read the answers and the rubric in `~/gaitscope-llm-lab/results/quality-scores.md`.
8. **The instructor's view** (already open in CLAUDE.md): is a tutor acceptable for the course at all, as a
   checker rather than a writer, and should the hand-off point at ASU's accounts by default?
9. **WebLLM with the 4B** (11.4): is it stable on other laptops, and as good as Transformers.js's 4B on the
   golden questions? If so, it makes Tier L's follow-ups ~10× cheaper.
10. **Can fine-tuning lift a 0.8B model** from 3–6 to ~10 of 12 on held-out questions (11.5)? This is the one
    result that would re-open the phone tier.

### Risks

| Risk | Likelihood | What changes |
|---|---|---|
| A student on a slow or metered connection starts the 2.8 GB Tier L download | Medium | Offer it only on laptops, show the size and the Wi-Fi advice, and make Tier 0 good enough that skipping it costs little |
| Students paste their trace into personal assistant accounts with weaker data terms | Medium | The hand-off copies only the derived trace (no raw samples), and says which ASU accounts are FERPA-approved |
| Transformers.js 4.3.1 pins an ONNX Runtime **dev** build (`1.31.0-dev.20260914`) | Low–medium | Pin the Transformers.js version and model commits; re-run the golden test and section 8 before any upgrade |
| A model repo is re-exported under the same name | Medium over a year | Pinning the commit (`revision`) makes it a deliberate upgrade |
| The 4B model still slips (it blamed variability on the wrong cause) | Medium | Number guard, rules deciding checks, and the template answer always shown first |
| Hugging Face rate-limits a class behind one campus IP | Low (the download is opt-in and laptop-only) | Stagger downloads; mirroring isn't possible for 2.8 GB on Pages |
| The tutor becomes the thing that writes students' explanations | Depends on the course | The design checks rather than writes; keep it that way |
| Chrome ships the Prompt API on Android, or a sub-1B model passes the golden test | Unknown | Re-open the phone tier |

## 11. Beyond Transformers.js: other runtimes, precision, and routes to a phone tier

Added after review. Sections 3–5 measured one runtime (Transformers.js) at one precision (4-bit), so "no model
on phones" might have been a property of that setup rather than of model size. This section tests that with
two other in-browser runtimes, two other precisions (8-bit, fp16) and two other 4-bit formats on the same model
and the same prompts, then plans the two routes that could still give phones a model. Same laptop, browser, flags, prompts and rubric as
before; harness batches F and G (section 9).

Runtimes: **WebLLM** 0.2.85 (MLC; models compiled to WebGPU ahead of time) and **wllama** 3.8.1 (llama.cpp
compiled to WebAssembly, with llama.cpp's WebGPU backend, the one the LlamaWeb paper describes).

### 11.1 Same model, three runtimes, three precisions

Qwen3.5-0.8B everywhere, plus LFM2.5-350M (the fastest small model) and Qwen3.5-2B where they add something.
Prefill and decode are medians over the speed matrix, as in 3.2 [M]:

| Model · runtime · format | Download | Prefill tok/s | Decode tok/s | First token at ~560 / ~800 / ~2,100 tokens (s) | Peak renderer / GPU (GB) | Cached load (s) | Quality /12 |
|---|---:|---:|---:|---|---|---:|---:|
| Qwen3.5-0.8B · Transformers.js · q4f16 | 470 MB | 655 | 40 | 0.9 / 1.2 / 3.4 | 1.8 / 1.5 | 1.6 | 6 |
| Qwen3.5-0.8B · Transformers.js · **fp16** | 1,539 MB | 853 | 21 | 0.6 / 0.9 / 2.8 | 5.1 / 2.8 | — | 3 |
| Qwen3.5-0.8B · **WebLLM** · q4f16_1 | 447 MB | 648 | 45 | 0.8 / 1.2 / 3.7 | 0.7 / 2.5 | 1.4 | 3 |
| Qwen3.5-0.8B · **llama.cpp** · Q4_K_M | 533 MB | 255 | 33 | 2.2 / 3.1 / 8.9 | 1.6 / 1.5 | 2.3 | 4.5 |
| Qwen3.5-0.8B · **llama.cpp** · **Q8_0** | 812 MB | 236 | 37 | 2.4 / 3.4 / 9.4 | 1.9 / 1.1 | 2.3 | 5.5 |
| LFM2.5-350M · Transformers.js · q4f16 | 255 MB | 1,553 | 91 | 0.3 / 0.5 / 1.3 | 1.2 / 0.8 | 0.9 | 1 |
| LFM2.5-350M · **llama.cpp** · Q4_K_M | 229 MB | 463 | 65 | 1.2 / 1.5 / 4.2 | **0.7 / 0.5** | 2.4 | 2 |
| Qwen3.5-2B · **WebLLM** · q4f16_1 | 1,083 MB | 256 | 27 | 2.2 / **GPU device lost** / — | 0.9 / 2.4 | 3.3 | — (device lost) |

What it shows:

- **Neither precision nor runtime fixes the quality.** Five variants of the same 0.8B model scored 3–6 of
  12; the unquantized fp16 version scored lowest. All five endorsed the student's wrong explanation (inventing
  "h = 1.2 g" or "1.5 g") and all five gave shoe advice. One greedy sample per question moves a score by a
  point or two, so these are equal within noise. **Model size is what limits quality here** (3.6: 4B scored
  11), so the conclusion of section 7 stands.
- **WebLLM ≈ Transformers.js in speed** on this GPU (decode 14% faster), with less renderer memory and more GPU
  memory, about the same in total. Its 2B model lost the GPU device at an ~800-token prompt, twice
  (GPU memory had risen only 2.4 GB of 16), so this configuration is unstable here. Transformers.js's 2B
  export also failed on this machine (3.3). Both are on the flag-only AMD/Linux WebGPU path, so this may not
  generalise [E].
- **llama.cpp is slower here** (prefill 2.6×, decode ~15% slower than Transformers.js for Qwen3.5-0.8B), the
  opposite of the LlamaWeb paper's averages over four GPUs from different vendors (+69% decode against
  Transformers.js). Its memory advantage did show for LFM2.5-350M: 0.7 + 0.5 GB against 1.2 + 0.8 GB (40%
  less), which is what phones lack.
- **8-bit decodes faster than 4-bit in llama.cpp** (37 vs 33 tok/s), as the LlamaWeb paper also found. A likely reason is that decoding
  isn't purely bandwidth-bound at this size, so 4-bit dequantization costs show [E]. fp16 in Transformers.js
  shows the other side: faster prefill (no dequantization) but half the decode speed (4× the bytes per token).
- **Download sizes are close** for current exports: 447 (MLC), 470 (ONNX) and 533 MB (GGUF Q4_K_M) for
  Qwen3.5-0.8B; 229 vs 255 MB for LFM2.5-350M. The 1.5–1.7× gap reported for older exports (Qwen3-0.6B: 335 MB
  MLC vs 570 MB ONNX) has mostly closed.
- **Runtime code**: Transformers.js 168 KB + 5.5 MB (brotli); WebLLM 1.9 MB + a 0.7 MB model library per model
  (via jsDelivr's GitHub mirror, `cdn.jsdelivr.net/gh/mlc-ai/binary-mlc-llm-libs@<commit>/…`, which keeps
  CLAUDE.md's "pinned on jsDelivr" rule); wllama 156 KB + 2.0 MB [M: `curl` with brotli].

### 11.2 Follow-up questions: where the other runtimes win

The follow-up test of 3.5, for Qwen3.5-0.8B [M]:

| Runtime | Turn 2 with the cache | Turn 2 from scratch | Speed-up |
|---|---|---|---:|
| Transformers.js | 27 new tokens, but 1.39 s: no gain, and only 806 of 873 cached tokens matched the re-rendered history | 1.39 s | none |
| **WebLLM** | **28 tokens prefilled, 0.15–0.18 s** | 1.63–1.71 s | **~10×** |
| **llama.cpp** | **94 tokens prefilled, 0.76 s** | 3.46–3.70 s | **~4.7×** |

- WebLLM keeps its own conversation state, so the template mismatch that broke Transformers.js doesn't arise.
- llama.cpp compares tokens and reuses the longest common prefix (`cache_prompt`). It even reused the shared
  system prompt and trace **across independent questions**: the second "turn 1", a new conversation, prefilled
  426 of 810 tokens. That is row 8 of 4.1 ("prefill the system prompt and trace once") built in.
- For Tier L, whose follow-ups would otherwise cost a full prefill (about 5 s for 400 tokens with the 4B on this
  iGPU), this is the strongest reason to consider WebLLM.

### 11.3 The CPU path in llama.cpp

Section 3.4 found the CPU path unusable, but with ONNX Runtime. llama.cpp's own CPU kernels (wllama with no GPU
layers, same laptop) [M]:

| CPU, no GPU | Prefill tok/s | Decode tok/s | First token at ~550 tokens |
|---|---:|---:|---:|
| ONNX Runtime · Qwen3-0.6B · 1 thread (3.4) | 27 | 1.4 | 21 s |
| llama.cpp · LFM2.5-350M · 1 thread | 28 | 16–20 | 18.6 s |
| llama.cpp · LFM2.5-350M · 8 threads (isolated) | 97–114 | 50–58 | 4.6 s |
| llama.cpp · Qwen3.5-0.8B · 1 thread | 11 | 6.4–7.5 | 52 s |
| llama.cpp · Qwen3.5-0.8B · 8 threads (isolated) | 46–48 | 18–25 | 12 s |

- **Decoding on the CPU is 5–10× faster in llama.cpp** than in ONNX Runtime at comparable sizes, and
  multithreading is worth 3.5–4.6× there, against nothing on the WebGPU path (threads made llama.cpp's WebGPU run
  no faster: 210–231 vs 255–295 tok/s prefill).
- **Prefill on one thread stays slow** (11–28 tok/s), and phones' CPUs are slower than this laptop's [E].
- So a CPU tier is no longer ruled out by speed, only by quality: if a small model ever passes the golden test
  (11.5), llama.cpp is its runtime on devices without WebGPU, and cross-origin isolation through
  `coi-serviceworker` becomes worth its reload (4.1, row 9).

### 11.4 Verdicts on the runtimes

| Runtime | Strengths measured here | Weaknesses measured here | Verdict |
|---|---|---|---|
| **Transformers.js 4.3** | Fastest small-model prefill; widest model choice | Largest runtime download (5.7 MB); follow-up reuse fails for Qwen3.5; CPU path 5–10× slower than llama.cpp; many exports lack `num_logits_to_keep` or don't run on WASM | **Keep as the default for Tier L for now**: it ran the 4B that scored 11 |
| **WebLLM 0.2.85** | Same speed, 14% faster decode; correct 10× follow-ups; less renderer memory; ~2.6 MB of runtime code | GPU device lost with the 2B model on this iGPU; WebGPU only (no CPU path); models limited to MLC's list unless the owner converts weights | **Try for Tier L**: measure Qwen3.5-4B (2.4 GB MLC) on the owner's and other laptops; switch if it's stable, since follow-ups get 10× cheaper |
| **wllama 3.8.1 (llama.cpp)** | 40% less memory for LFM2.5; automatic prefix caching across questions; a CPU path 5–10× faster than ONNX Runtime's; ~2.2 MB of code | 2.6× slower prefill on this GPU | **The runtime for any future phone or CPU tier** (memory, CPU speed); not for Tier L on this hardware |
| LiteRT-LM JS, MediaPipe | — | Early preview / maintenance-only [V] | **Watch** |

### 11.5 Fine-tuning a small model on gaitscope questions (a plan)

The quality cut-off in 3.6 is about general small models answering questions about *this* code. A model
trained on this narrow task could do better at 0.8B, which would make a phone tier possible again. Nothing here
was trained; this is a plan with its costs [U unless marked].

1. **Training data, generated by code.** Run `core.js` over synthetic recordings that vary the things the
   tutor explains: algorithm, filter, sampling rate, tied peaks, stop bumps, strides vs steps, uneven timing.
   Each run gives a trace (7.5). For each trace and each question type, the **target answer is the template
   answer** (4.1, row 2), which is correct by construction, plus paraphrases for variety. About 2,000–5,000
   examples [E].
2. **Who may write the targets.** Anthropic's terms forbid "Using Outputs as training targets for models"
   without written permission [V: [Claude Help Center](https://support.claude.com/en/articles/12326764-can-i-use-my-outputs-to-train-an-ai-model),
   2026-03-16]. So Claude (including this session) must not write the target answers or the paraphrases.
   The templates should be written or rewritten by the owner, and paraphrases generated by an open-weight
   model whose licence puts no limit on its outputs (Qwen3.5 is Apache-2.0), run in the owner's own free
   Kaggle or Colab session. The owner's prompts are fine there: no student data is involved.
3. **Training.** LoRA on Qwen3.5-0.8B, on a free Kaggle T4 (30 GPU h/week). About 5M training tokens is
   roughly one to a few hours per epoch on a T4 [E]. Whether the usual LoRA tooling handles Qwen3.5's hybrid
   Gated DeltaNet layers needs checking first [U].
4. **Export for the page.** Easiest through the runtimes measured in 11.1–11.4: `mlc_llm convert_weight` makes WebLLM
   weights for a fine-tune of an architecture WebLLM already supports, and the existing model library is
   reused [V: [MLC docs](https://llm.mlc.ai/docs/compilation/convert_weights.html)]; llama.cpp's
   `convert_hf_to_gguf.py` + `llama-quantize` make a GGUF. A Transformers.js export with
   `num_logits_to_keep` is harder to reproduce.
5. **Publish** on the owner's Hugging Face account (free; static files the owner publishes are allowed), with a
   pinned revision.
6. **Gate**: the golden-question test (7.6) on held-out traces and questions, not the training templates.

**Cost**: owner time, mostly writing templates (which Tier 0 needs anyway) and the evaluation; no money. **Risk**:
a fine-tune learns the templates' phrasing and still fails on unforeseen questions, which are the only ones the
templates don't already answer. **Verdict: try**, after Tier 0 exists, because Tier 0's templates are its
training data.

### 11.6 Trimming the vocabulary (a plan)

Qwen3.5 uses a 248,320-token vocabulary for 201 languages. In the small models that table is a large share of
the weights [V: the models' `config.json`]:

| Model | Hidden size | Embedding parameters | Share of the model | Compute per output token spent on the vocabulary |
|---|---:|---:|---:|---:|
| Qwen3.5-0.8B | 1,024 | 254M (tied with the output layer) | about 30% | about 30% [E] |
| Qwen3.5-4B | 2,560 | 636M (tied) | about 16% | about 15% [E] |

- **The method**: keep only the tokens an English-language tutor needs (English text, digits, units, the
  chat template's special tokens, and the 256 byte tokens so anything can still be encoded), and drop the
  matching rows of the embedding and the output layer. On multilingual models, keeping about half the
  vocabulary for one language kept the original quality
  ([Ushio et al., EMNLP Findings 2023](https://arxiv.org/abs/2305.15020); tool:
  [lm-vocab-trimmer](https://github.com/asahi417/lm-vocab-trimmer)).
- **What it would save**, keeping ~32k tokens [E]: about 110–120 MB of the 0.8B's 470 MB `q4f16` download and
  roughly a quarter of its per-token compute; for the 4B about 300 MB per copy of the table (the ONNX export
  stores it twice: `embed_tokens` and the output layer). Logits shrink by the same factor, which also helps the
  exports that lack `num_logits_to_keep` (3.3).
- **Cost and risk**: a re-export (tokenizer remap, then the same export steps as 11.5), published on the
  owner's Hugging Face account; non-English names and symbols get split into more tokens; every model
  update means doing it again.
- **Verdict: try together with 11.5**, since a fine-tune needs a re-export anyway. On its own it trims cost but
  doesn't fix the quality problem that rules out small models.

### 11.7 Other routes, briefly

| Technique | Saves | Evidence | Verdict |
|---|---|---|---|
| **Ask on the laptop, record on the phone** | Everything on the phone | The phone records (#51) and exports (#53); the laptop opens the export and runs Tier L. Works today, no new code [V: the merged features] | **Adopt**: say it in the phone UI ("for a longer explanation, open this recording on your laptop") |
| **Pair the phone with the student's own laptop** (WebRTC, offer/answer exchanged by QR codes, no signalling server) | The phone uses the laptop's Tier L model | Possible without any owner-run server on one network [E]; a lot of code for what the previous row already gives | **Reject** for now |
| **Prompt-lookup / speculative decoding** | Decode time when answers copy from the trace | Not in Transformers.js 4.3.1 [V: source]; harder for Qwen3.5 and Granite-H, whose recurrent layers can't be rolled back after a rejected guess without saving their state [E] | **Reject** for now; revisit if a runtime ships it for hybrid models |
| **Cache answers** per (trace hash, question, model) in IndexedDB | Repeat questions cost nothing | Trivial | **Adopt** with Tier L |
| **Score fixed choices with one prefill** instead of generating (e.g. "which card answers this?") | Decode | On phones the prefill is the expensive part (3.1), and small models judged badly (3.6); rules and BM25 pick cards for free | **Reject** |
| **8-bit KV cache** (ONNX Runtime 1.30) | Memory at long contexts | Prompts here are 400–1,000 tokens, and the hybrid models' KV caches are tens of MB [E] | **Reject** |
| **Background Fetch** | A large download survives closing the tab | Experimental, Chromium only, needs a service worker [V: [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API)] | **Reject** while phones get no model; reconsider with a phone tier |
| **Cross-Origin Storage** | One download shared by every site using the same model | A proposal; Transformers.js has experimental support behind `env.experimental_useCrossOriginStorage`, needing an extension today [V: runtime notes] | **Watch** |
| **WebNN on NPUs** | Battery on laptops with NPUs | Chrome origin trial from 147, desktop only; not exposed on this Linux laptop despite its NPU [V, M] | **Watch** |

### 11.8 What changes in the recommendation

- **Phones: no change.** The limit is answer quality, which follows model size, not the runtime or the
  precision (11.1). The two routes that could still give phones a model are a fine-tuned small model (11.5),
  ideally with a trimmed vocabulary (11.6), run in llama.cpp for its smaller memory footprint, and tested on the
  Pixel 9a with the golden questions. Until then, phones get Tier 0, the hand-off, and "open this recording on
  your laptop" (11.7).
- **Tier L: same model, a second runtime to try.** Qwen3.5-4B stays the model. Transformers.js stays the default,
  because it ran the 4B that scored 11. WebLLM should be measured with the 4B (2.4 GB) on the owner's and other
  laptops: if it's stable, it makes follow-up questions ~10× cheaper (11.2) and loads less runtime code.
- **CPU-only devices: still Tier 0**, but no longer for speed reasons. If a small model passes the golden test,
  llama.cpp (wllama) plus cross-origin isolation through `coi-serviceworker` is the CPU path (11.3).
- **CLAUDE.md (7.8)**: whichever runtime is adopted takes Transformers.js's place in the proposed rule. WebLLM's
  per-model libraries can come from jsDelivr's GitHub mirror pinned to a commit, so "pinned on jsDelivr" still
  holds; its model files come from Hugging Face like the others.
- **Phone test plan**: steps 10 and 11 of 8.2 run the same models in llama.cpp and WebLLM on the Pixel, next to
  Transformers.js's steps 2 and 4.
