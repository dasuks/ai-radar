# Local open-weight quality versus GPT-6 Luna — 2026-10-09

## Finding

Qwen3.8-27B at **xhigh** is a credible quality candidate for a 64 GB Mac: its current Artificial Analysis Intelligence Index is **34**, between GPT-6 Luna **high 33** and **xhigh 35**. This is aggregate benchmark proximity, not proof that a Mac 4-bit/8-bit copy matches the API evaluation or Korean news analysis. The comparison pages explicitly use **AA Intelligence Index v4.3.2**. [High comparison](https://artificialanalysis.ai/models/comparisons/gpt-6-luna-high-vs-qwen3-8-27b), [Xhigh comparison](https://artificialanalysis.ai/models/comparisons/gpt-6-luna-xhigh-vs-qwen3-8-27b).

Do not mix these figures with older AA article scores or with similarly named GPT-5.6 Luna. Index revisions change the evaluation set. Current direct comparison pages are the comparison basis here.

## Four concrete candidates

| Exact model/effort | AA v4.3.2 | 64 GB local feasibility | Evidence |
|---|---:|---|---|
| Qwen3.8-27B xhigh | 34 | Strong candidate; available MLX 8-bit conversion. About 29.5 GB weights reported in conversion-repository documentation PR; actual process uses more memory. | [AA](https://artificialanalysis.ai/models/qwen3-8-27b), [official card](https://huggingface.co/Qwen/Qwen3.8-27B), [MLX config](https://huggingface.co/mlx-community/Qwen3.8-27B-8bit/blob/main/config.json), [memory documentation PR](https://huggingface.co/mlx-community/Qwen3.8-27B-8bit/discussions/2/files) |
| K2-Horizon-MoVA-36B-A4B, high per official guidance | 25 | MLX collection lists 8-bit 37 GB, mixed 4-bit 25 GB; plausible fit with context controlled. No M5 Pro speed test verified here. | [AA](https://artificialanalysis.ai/models/k2-horizon-mova-36b-a4b), [official card](https://huggingface.co/IFM/K2-Horizon-MoVA-36B-A4B), [converter collection](https://huggingface.co/collections/mlx-community/k2-horizon-mova-36b-a4b) |
| Qwen3.6-35B-A3B Reasoning | 18 | 35B total/3B active official architecture; quantized weights fit in principle. Faster MoE candidate, substantially behind Luna on this index. | [AA comparison](https://artificialanalysis.ai/models/comparisons/qwen3-6-35b-a3b-vs-gemma-4-26b-a4b), [official card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) |
| Gemma 4 26B A4B Reasoning | **17 estimated** | 25.2B total/3.8B active according to AA; quantized weight size comfortably below 64 GB in principle. Not evidence of Luna-like quality. | [AA release](https://artificialanalysis.ai/models/releases/gemma-4-26b-a4b), [official card](https://huggingface.co/google/gemma-4-26B-A4B-it) |

Memory feasibility above is conditional: quantized weight storage plus KV cache, working buffers, vision encoder, macOS and other apps must fit. The supported maximum context is not a guarantee that the maximum fits in 64 GB. MoE active parameters determine some compute cost; **total** parameters still drive resident weight memory. For estimates, 35 billion 8-bit weights alone are approximately 35 decimal GB before overhead. No device execution was performed in this research.

The requested name “Qwen3.8 35B A3B” was not verified. The official model found is **Qwen3.6-35B-A3B**. Qwen3.8-27B has separate xhigh/medium/low/non-reasoning AA entries: **34/28/26/20**. Recommending the 34-point result requires keeping the xhigh reasoning setting. [Current release comparison](https://artificialanalysis.ai/models/releases/comparisons/qwen3-8-27b-vs-qwen3-6-35b-a3b), [medium/non-reasoning](https://artificialanalysis.ai/models/comparisons/qwen3-8-27b-non-reasoning-vs-qwen3-8-27b-medium), [low](https://artificialanalysis.ai/models/qwen3-8-27b-low).

## Where Qwen3.8-27B is and is not comparable

| Evaluation | Luna high | Luna xhigh | Qwen3.8-27B xhigh |
|---|---:|---:|---:|
| AA-Briefcase v1.1 | 1186 | 1237 | 1397 |
| GDPval-AA v2.1 | 1344 | 1364 | 1423 |
| AutomationBench-AA | 48% | 48% | 48% |
| Terminal-Bench 4.0 | 5% | 8% | 6% |
| SciCode | 50% | 52% | 47% |
| HLE | 33% | 34% | 34% |
| GDP.pdf | 18% | 19% | 17% |
| CritPt | 15% | 17% | 5% |
| AA-Omniscience | -6 | -2 | -10 |
| AA-LCR v1.1 | 79% | 80% | 82% |

Sources: [Luna high versus Qwen](https://artificialanalysis.ai/models/comparisons/gpt-6-luna-high-vs-qwen3-8-27b), [Luna xhigh versus Qwen](https://artificialanalysis.ai/models/comparisons/gpt-6-luna-xhigh-vs-qwen3-8-27b). SciCode and CritPt are marked “under review” on the AA page. These task differences do not support a blanket claim that either model always wins. A one-point composite difference alone also does not establish statistical superiority.

Qwen xhigh uses 67k weighted average output tokens per index task versus Luna high 20k / xhigh 27k. This benchmark work mix is not an estimate of news-brief length, but shows why similar answer quality may require much more local generation time. AA's output-speed figures are **API** measurements, not Mac measurements. [High comparison](https://artificialanalysis.ai/models/comparisons/gpt-6-luna-high-vs-qwen3-8-27b), [Xhigh comparison](https://artificialanalysis.ai/models/comparisons/gpt-6-luna-xhigh-vs-qwen3-8-27b).

## Exclusions and limits

- Qwen3.8-Flash-Next scores 40, but has **180B total / 6B active**: ordinary 4-bit weights alone imply 90 GB before overhead, so it is not an ordinary fully resident 64 GB option. [AA model](https://artificialanalysis.ai/models/qwen3-8-flash-next).
- Motif 3 scores 34 estimated but has 314B total parameters. Inkling Small has 266B. Their names/active counts are not evidence of 64 GB fit. [Motif](https://artificialanalysis.ai/models/motif-3), [Inkling](https://artificialanalysis.ai/models/inkling-small/).
- **UNVERIFIED EXTERNAL CONSTRAINT:** no same-harness AA v4.3.2 rerun of the exact Mac MLX 4/6/8-bit checkpoint was found here. Quantization, chat template, effort controls, generation limits and tool parsers could change scores. Verify with the exact local runtime before claiming parity.
- **UNVERIFIED EXTERNAL CONSTRAINT:** Korean factual summarization, evidence citation, JSON validity and ranking accuracy for AI Radar are not directly established by this index. A paired test using the project's real input/output contracts is required for a deployment claim; this research does not invent that result.

Practical inference: prioritize Qwen3.8-27B xhigh as the quality experiment; use an 8-bit copy when maximizing fidelity and a 4/6-bit copy only with explicit speed/quality validation. K2 Horizon is a newer alternate MoE candidate. Qwen3.6 and Gemma are valid local models but their current aggregate results do not substantiate GPT-6 Luna parity.
