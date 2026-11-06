# Mac mini M5 Pro 64GB: local LLM benchmark evidence

Checked 2026-10-09. User scenario: Discord Q&A, Orca, services and scheduled jobs on one machine. No hardware purchased or local inference performed in this research.

## Main finding

Qwen3.8 27B is a credible Luna-class quality candidate. Artificial Analysis v4.3.2 reports Qwen Xhigh 34 versus GPT-6 Luna High 33 and Xhigh 35. This is a hosted evaluation, not a validation of a Mac quantization. Reasoning settings and the serving harness matter. Korean Discord dialogue and concurrent Orca performance remain unmeasured.

Sources: [Luna High comparison](https://artificialanalysis.ai/models/comparisons/gpt-6-luna-high-vs-qwen3-8-27b), [Luna Xhigh comparison](https://artificialanalysis.ai/models/comparisons/gpt-6-luna-xhigh-vs-qwen3-8-27b).

## Local throughput: primary experiment reports

| Model / runtime | Generation speed | Evidence scope |
|---|---:|---|
| Qwen3.8 27B nvfp4, Ollama 0.32.13 | 32.79–34.38 tokens/s | M5 Pro /64GB; short, long, ~11k prompts |
| Qwen3.8 27B 4-bit, oMLX 0.6.0 | 19.88–26.28 tokens/s | Same author's M5 Pro /64GB, different quantization/MTP packaging |
| Qwen3.8 27B 8-bit, mlx_lm.server | 9.96 tokens/s | Separate first-person Mac mini M5 Pro /64GB report, 4k input |
| Qwen3.6 35B-A3B 8-bit, mlx_lm.server | 66.84 tokens/s | Same Mac mini report, 4k input |

These are small community experiments, not manufacturer guarantees or controlled head-to-head quality tests. Hardware core counts are not established for every row. Generation throughput excludes initial input processing and does not equal time until a useful answer. Runtime versions, prompt lengths and compression differ; do not present the range as a universal hardware specification.

Sources: [benchmark repository and protocol](https://github.com/daniel29348679/m5pro-llm-bench), [raw Ollama comparison](https://github.com/daniel29348679/m5pro-llm-bench/blob/main/results/ollama_0.32.13_update/installed/00_comparison.md), [Mac mini owner's measurements](https://www.reddit.com/r/LocalLLM/comments/1wyz5yk/m5_pro_mini_qwen38_benchmarks_at_46bit_quants/).

The Ollama report's first uncached ~11k input took 27.45 seconds to first token; its subsequent cached trials make mean input throughput misleadingly large. Preserve this distinction when explaining responsiveness. At 30 generated tokens/s, 500 tokens alone take 16.7 seconds; add input processing, reasoning, and queue time. This is arithmetic, not a measured Korean-chat latency.

## Fit in 64GB

MLX Community publishes the Qwen3.8-27B 4-bit package at roughly 16.7GB and its 8-bit package at 29.5GB. Package size is not total process RAM. Context state, inference buffers, OS, browser, build tools and services need additional capacity. One quantized 27B model is a credible fit, but no evidence here validates maximum context plus concurrent builds or multiple simultaneous inference requests.

Sources: [4-bit files](https://huggingface.co/mlx-community/Qwen3.8-27B-4bit/tree/main), [8-bit files](https://huggingface.co/mlx-community/Qwen3.8-27B-8bit/tree/main).

## Operational inference

Quality-first candidate: Qwen3.8-27B; start by comparing 4-bit/8-bit on the actual task. Speed-first candidate: Qwen3.6-35B-A3B, without assuming its quality matches Qwen3.8. Keep one model loaded initially and queue Discord requests. Cap context and reasoning for casual Q&A; use heavier reasoning for offline jobs. These are recommendations derived from the evidence, not measured service-level guarantees.

Do not combine old AA scores around 52 with current v4.3.2 scores around 34. Do not conflate GPT-5.6 Luna with GPT-6 Luna. Do not use hosted Qwen price or output speed as a local Mac cost or speed measurement.
