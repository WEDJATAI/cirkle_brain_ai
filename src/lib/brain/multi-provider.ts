// Cirkle Brain AI — Multi-Provider Model Adapter (z-ai REMOVED)
//
// CONSENSUS: All z-ai references have been removed. The Brain now uses a TRUE
// multi-provider router across 5 independent providers:
//   1. Groq         — Llama, Mixtral, Gemma, Qwen, DeepSeek (ultra-fast inference)
//   2. OpenRouter   — gateway to 200+ models (Anthropic, Meta, Google, Mistral, Qwen, ...)
//   3. NVIDIA NIM   — Llama, Mistral, Phi, Gemma, Qwen (enterprise-grade)
//   4. Google Gemini — Gemini 2.0/1.5 Pro/Flash/Flash-Lite (multimodal, long context)
//   5. Hugging Face  — open-source Llama, Mistral, Qwen, Phi, DeepSeek
//
// Every provider exposes a different SDK/API format. This adapter normalizes them
// into a single interface: generate(messages) → { content, model, tokensIn, tokensOut }
//
// The model router selects the best provider+model based on task type, latency,
// cost, and availability. If one provider fails, it falls back to another.

export type ProviderName = "groq" | "openrouter" | "nvidia" | "gemini" | "huggingface";

export interface ProviderModel {
  provider: ProviderName;
  modelId: string;                 // canonical id "provider:raw-model"
  rawModelId: string;              // raw model id passed to the provider API
  displayName: string;
  tier: "FAST" | "BALANCED" | "REASONING" | "SPECIALIST";
  contextLimit: number;
  costInPer1k: number;
  costOutPer1k: number;
  capabilities: string[];
  privacyPolicy: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
  latencyP50Ms: number;
}

// ─── Provider Model Registry ─────────────────────────────────────────────
// Use ALL needed models from EACH provider. Curated to span the FAST /
// BALANCED / REASONING / SPECIALIST tiers across the 5 providers.

export const PROVIDER_MODELS: ProviderModel[] = [

  // ─────────────────────────────────────────────────────────────────────
  // GROQ — ultra-fast LPU inference. Free tier. OpenAI-compatible API.
  // Endpoint: https://api.groq.com/openai/v1/chat/completions
  // ─────────────────────────────────────────────────────────────────────
  // FAST tier — instant classification / simple Q&A
  {
    provider: "groq", modelId: "groq:llama-3.1-8b-instant",
    rawModelId: "llama-3.1-8b-instant",
    displayName: "Llama 3.1 8B Instant (Groq)",
    tier: "FAST", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "toolCalling", "structuredOutput"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 150,
  },
  {
    provider: "groq", modelId: "groq:llama-3.2-1b-preview",
    rawModelId: "llama-3.2-1b-preview",
    displayName: "Llama 3.2 1B Preview (Groq)",
    tier: "FAST", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "toolCalling"], privacyPolicy: "PUBLIC",
    latencyP50Ms: 120,
  },
  {
    provider: "groq", modelId: "groq:llama-3.2-3b-preview",
    rawModelId: "llama-3.2-3b-preview",
    displayName: "Llama 3.2 3B Preview (Groq)",
    tier: "FAST", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "toolCalling"], privacyPolicy: "PUBLIC",
    latencyP50Ms: 130,
  },
  {
    provider: "groq", modelId: "groq:gemma2-9b-it",
    rawModelId: "gemma2-9b-it",
    displayName: "Gemma 2 9B (Groq)",
    tier: "FAST", contextLimit: 8192, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "multilingual"], privacyPolicy: "PUBLIC",
    latencyP50Ms: 200,
  },
  // BALANCED tier — general purpose
  {
    provider: "groq", modelId: "groq:llama-3.3-70b-versatile",
    rawModelId: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B Versatile (Groq)",
    tier: "BALANCED", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "toolCalling", "structuredOutput", "coding", "multilingual"],
    privacyPolicy: "INTERNAL", latencyP50Ms: 300,
  },
  {
    provider: "groq", modelId: "groq:mixtral-8x7b-32768",
    rawModelId: "mixtral-8x7b-32768",
    displayName: "Mixtral 8x7B (Groq)",
    tier: "BALANCED", contextLimit: 32768, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "toolCalling", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 250,
  },
  {
    provider: "groq", modelId: "groq:llama-3.1-8b-instant-balanced",
    rawModelId: "llama-3.1-8b-instant",
    displayName: "Llama 3.1 8B Balanced (Groq)",
    tier: "BALANCED", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "toolCalling", "structuredOutput"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 180,
  },
  // REASONING tier — chain-of-thought
  {
    provider: "groq", modelId: "groq:deepseek-r1-distill-llama-70b",
    rawModelId: "deepseek-r1-distill-llama-70b",
    displayName: "DeepSeek R1 Distill 70B (Groq)",
    tier: "REASONING", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "coding"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 900,
  },
  {
    provider: "groq", modelId: "groq:deepseek-r1-distill-qwen-32b",
    rawModelId: "deepseek-r1-distill-qwen-32b",
    displayName: "DeepSeek R1 Distill Qwen 32B (Groq)",
    tier: "REASONING", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 700,
  },
  {
    provider: "groq", modelId: "groq:qwen-2.5-coder-32b",
    rawModelId: "qwen-2.5-coder-32b",
    displayName: "Qwen 2.5 Coder 32B (Groq)",
    tier: "REASONING", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "coding", "reasoning"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 600,
  },

  // ─────────────────────────────────────────────────────────────────────
  // OPENROUTER — gateway to 200+ models. Pay-as-you-go.
  // Endpoint: https://openrouter.ai/api/v1/chat/completions
  // ─────────────────────────────────────────────────────────────────────
  // FAST tier
  {
    provider: "openrouter", modelId: "openrouter:google/gemini-flash-1.5",
    rawModelId: "google/gemini-flash-1.5",
    displayName: "Gemini Flash 1.5 (OpenRouter)",
    tier: "FAST", contextLimit: 1000000, costInPer1k: 0.0000375, costOutPer1k: 0.00015,
    capabilities: ["text", "vision", "longContext", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 500,
  },
  {
    provider: "openrouter", modelId: "openrouter:meta-llama/llama-3.1-8b-instruct",
    rawModelId: "meta-llama/llama-3.1-8b-instruct",
    displayName: "Llama 3.1 8B Instruct (OpenRouter)",
    tier: "FAST", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "toolCalling"], privacyPolicy: "PUBLIC",
    latencyP50Ms: 400,
  },
  {
    provider: "openrouter", modelId: "openrouter:mistralai/mistral-7b-instruct",
    rawModelId: "mistralai/mistral-7b-instruct",
    displayName: "Mistral 7B Instruct (OpenRouter)",
    tier: "FAST", contextLimit: 32768, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "multilingual"], privacyPolicy: "PUBLIC",
    latencyP50Ms: 350,
  },
  // BALANCED tier
  {
    provider: "openrouter", modelId: "openrouter:meta-llama/llama-3.3-70b-instruct",
    rawModelId: "meta-llama/llama-3.3-70b-instruct",
    displayName: "Llama 3.3 70B Instruct (OpenRouter)",
    tier: "BALANCED", contextLimit: 128000, costInPer1k: 0.0006, costOutPer1k: 0.0006,
    capabilities: ["text", "reasoning", "coding", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 800,
  },
  {
    provider: "openrouter", modelId: "openrouter:qwen/qwen-2.5-72b-instruct",
    rawModelId: "qwen/qwen-2.5-72b-instruct",
    displayName: "Qwen 2.5 72B Instruct (OpenRouter)",
    tier: "BALANCED", contextLimit: 32768, costInPer1k: 0.00023, costOutPer1k: 0.00023,
    capabilities: ["text", "reasoning", "coding", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 700,
  },
  {
    provider: "openrouter", modelId: "openrouter:mistralai/mistral-large",
    rawModelId: "mistralai/mistral-large",
    displayName: "Mistral Large (OpenRouter)",
    tier: "BALANCED", contextLimit: 128000, costInPer1k: 0.002, costOutPer1k: 0.006,
    capabilities: ["text", "reasoning", "coding", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 750,
  },
  // REASONING tier
  {
    provider: "openrouter", modelId: "openrouter:anthropic/claude-3.5-sonnet",
    rawModelId: "anthropic/claude-3.5-sonnet",
    displayName: "Claude 3.5 Sonnet (OpenRouter)",
    tier: "REASONING", contextLimit: 200000, costInPer1k: 0.003, costOutPer1k: 0.015,
    capabilities: ["text", "reasoning", "coding", "vision", "longContext"], privacyPolicy: "CONFIDENTIAL",
    latencyP50Ms: 1500,
  },
  {
    provider: "openrouter", modelId: "openrouter:openai/gpt-4o-mini",
    rawModelId: "openai/gpt-4o-mini",
    displayName: "GPT-4o mini (OpenRouter)",
    tier: "REASONING", contextLimit: 128000, costInPer1k: 0.00015, costOutPer1k: 0.0006,
    capabilities: ["text", "reasoning", "vision", "toolCalling"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 900,
  },
  {
    provider: "openrouter", modelId: "openrouter:deepseek/deepseek-r1",
    rawModelId: "deepseek/deepseek-r1",
    displayName: "DeepSeek R1 (OpenRouter)",
    tier: "REASONING", contextLimit: 64000, costInPer1k: 0.00055, costOutPer1k: 0.00219,
    capabilities: ["text", "reasoning", "coding"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 1800,
  },
  {
    provider: "openrouter", modelId: "openrouter:google/gemini-2.0-flash-001",
    rawModelId: "google/gemini-2.0-flash-001",
    displayName: "Gemini 2.0 Flash (OpenRouter)",
    tier: "REASONING", contextLimit: 1048576, costInPer1k: 0.0001, costOutPer1k: 0.0004,
    capabilities: ["text", "reasoning", "vision", "longContext", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 800,
  },
  // SPECIALIST tier — frontier models for high-stakes work
  {
    provider: "openrouter", modelId: "openrouter:openai/gpt-4o",
    rawModelId: "openai/gpt-4o",
    displayName: "GPT-4o (OpenRouter)",
    tier: "SPECIALIST", contextLimit: 128000, costInPer1k: 0.0025, costOutPer1k: 0.01,
    capabilities: ["text", "reasoning", "coding", "vision", "toolCalling"], privacyPolicy: "CONFIDENTIAL",
    latencyP50Ms: 2000,
  },
  {
    provider: "openrouter", modelId: "openrouter:anthropic/claude-3.7-sonnet",
    rawModelId: "anthropic/claude-3.7-sonnet",
    displayName: "Claude 3.7 Sonnet (OpenRouter)",
    tier: "SPECIALIST", contextLimit: 200000, costInPer1k: 0.003, costOutPer1k: 0.015,
    capabilities: ["text", "reasoning", "coding", "vision", "longContext"], privacyPolicy: "RESTRICTED",
    latencyP50Ms: 2200,
  },

  // ─────────────────────────────────────────────────────────────────────
  // NVIDIA NIM — enterprise-grade inference. Free credits on signup.
  // Endpoint: https://integrate.api.nvidia.com/v1/chat/completions
  // Note: NVIDIA NIM requires account-level subscription to each model. The
  // registry below lists models that have historically been available; the
  // fallback chain handles "Function not found for account" gracefully.
  // ─────────────────────────────────────────────────────────────────────
  // FAST tier
  {
    provider: "nvidia", modelId: "nvidia:nvidia/llama-3.1-nemotron-70b-instruct",
    rawModelId: "nvidia/llama-3.1-nemotron-70b-instruct",
    displayName: "Nemotron 70B Instruct (NVIDIA)",
    tier: "FAST", contextLimit: 131072, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "toolCalling"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 400,
  },
  {
    provider: "nvidia", modelId: "nvidia:google/gemma-3-12b-it",
    rawModelId: "google/gemma-3-12b-it",
    displayName: "Gemma 3 12B (NVIDIA)",
    tier: "FAST", contextLimit: 131072, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "multilingual"], privacyPolicy: "PUBLIC",
    latencyP50Ms: 350,
  },
  // BALANCED tier
  {
    provider: "nvidia", modelId: "nvidia:mistralai/mistral-large-2-instruct",
    rawModelId: "mistralai/mistral-large-2-instruct",
    displayName: "Mistral Large 2 (NVIDIA)",
    tier: "BALANCED", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "coding", "toolCalling", "multilingual"],
    privacyPolicy: "CONFIDENTIAL", latencyP50Ms: 600,
  },
  {
    provider: "nvidia", modelId: "nvidia:ibm/granite-3.0-8b-instruct",
    rawModelId: "ibm/granite-3.0-8b-instruct",
    displayName: "IBM Granite 3.0 8B (NVIDIA)",
    tier: "BALANCED", contextLimit: 4096, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "toolCalling"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 400,
  },
  // REASONING tier
  {
    provider: "nvidia", modelId: "nvidia:nvidia/llama-3.1-nemotron-ultra-253b-v1",
    rawModelId: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    displayName: "Nemotron Ultra 253B (NVIDIA)",
    tier: "REASONING", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "longContext"], privacyPolicy: "RESTRICTED",
    latencyP50Ms: 2000,
  },
  {
    provider: "nvidia", modelId: "nvidia:moonshotai/kimi-k3",
    rawModelId: "moonshotai/kimi-k3",
    displayName: "Kimi K3 (NVIDIA)",
    tier: "REASONING", contextLimit: 256000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "coding", "longContext"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 1800,
  },
  {
    provider: "nvidia", modelId: "nvidia:nvidia/nemotron-3-super-120b-a12b",
    rawModelId: "nvidia/nemotron-3-super-120b-a12b",
    displayName: "Nemotron 3 Super 120B (NVIDIA)",
    tier: "REASONING", contextLimit: 131072, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 1700,
  },

  // ─────────────────────────────────────────────────────────────────────
  // GOOGLE GEMINI — direct API. Free tier generous.
  // Endpoint: https://generativelanguage.googleapis.com/v1beta/models/...
  // Note: API may return 400 "User location is not supported" in some
  // regions — the fallback chain handles this gracefully by trying the
  // next provider.
  // ─────────────────────────────────────────────────────────────────────
  // FAST tier
  {
    provider: "gemini", modelId: "gemini:gemini-2.0-flash-lite",
    rawModelId: "gemini-2.0-flash-lite",
    displayName: "Gemini 2.0 Flash Lite",
    tier: "FAST", contextLimit: 1048576, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "vision", "longContext", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 350,
  },
  {
    provider: "gemini", modelId: "gemini:gemini-2.0-flash",
    rawModelId: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    tier: "FAST", contextLimit: 1048576, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "vision", "longContext", "multilingual", "toolCalling"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 500,
  },
  {
    provider: "gemini", modelId: "gemini:gemini-1.5-flash-8b",
    rawModelId: "gemini-1.5-flash-8b",
    displayName: "Gemini 1.5 Flash 8B",
    tier: "FAST", contextLimit: 1000000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "vision", "longContext", "multilingual"], privacyPolicy: "PUBLIC",
    latencyP50Ms: 300,
  },
  // BALANCED tier
  {
    provider: "gemini", modelId: "gemini:gemini-1.5-flash",
    rawModelId: "gemini-1.5-flash",
    displayName: "Gemini 1.5 Flash",
    tier: "BALANCED", contextLimit: 1000000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "vision", "longContext", "multilingual", "toolCalling"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 400,
  },
  // REASONING tier
  {
    provider: "gemini", modelId: "gemini:gemini-1.5-pro",
    rawModelId: "gemini-1.5-pro",
    displayName: "Gemini 1.5 Pro",
    tier: "REASONING", contextLimit: 2000000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "vision", "reasoning", "longContext", "multilingual", "toolCalling"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 1200,
  },

  // ─────────────────────────────────────────────────────────────────────
  // HUGGING FACE — open-source models via the HF router (OpenAI-compatible).
  // Endpoint: https://router.huggingface.co/v1/chat/completions
  // Note: the legacy api-inference.huggingface.co endpoint is deprecated.
  // ─────────────────────────────────────────────────────────────────────
  // FAST tier
  {
    provider: "huggingface", modelId: "huggingface:Qwen/Qwen3.8-27B",
    rawModelId: "Qwen/Qwen3.8-27B",
    displayName: "Qwen 3.8 27B (HF)",
    tier: "FAST", contextLimit: 1000000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "vision", "multilingual", "toolCalling"],
    privacyPolicy: "INTERNAL", latencyP50Ms: 700,
  },
  // BALANCED tier
  {
    provider: "huggingface", modelId: "huggingface:meta-llama/Llama-3.3-70B-Instruct",
    rawModelId: "meta-llama/Llama-3.3-70B-Instruct",
    displayName: "Llama 3.3 70B Instruct (HF)",
    tier: "BALANCED", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "coding", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 1500,
  },
  {
    provider: "huggingface", modelId: "huggingface:deepseek-ai/DeepSeek-R1",
    rawModelId: "deepseek-ai/DeepSeek-R1",
    displayName: "DeepSeek R1 (HF)",
    tier: "BALANCED", contextLimit: 64000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "coding"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 2000,
  },
  {
    provider: "huggingface", modelId: "huggingface:Qwen/Qwen2.5-72B-Instruct",
    rawModelId: "Qwen/Qwen2.5-72B-Instruct",
    displayName: "Qwen 2.5 72B Instruct (HF)",
    tier: "BALANCED", contextLimit: 32768, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "coding", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 1700,
  },
  // REASONING tier
  {
    provider: "huggingface", modelId: "huggingface:meta-llama/Llama-3.1-405B-Instruct",
    rawModelId: "meta-llama/Llama-3.1-405B-Instruct",
    displayName: "Llama 3.1 405B Instruct (HF)",
    tier: "REASONING", contextLimit: 128000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "coding", "multilingual"], privacyPolicy: "RESTRICTED",
    latencyP50Ms: 3000,
  },
  {
    provider: "huggingface", modelId: "huggingface:deepseek-ai/DeepSeek-V3",
    rawModelId: "deepseek-ai/DeepSeek-V3",
    displayName: "DeepSeek V3 (HF)",
    tier: "REASONING", contextLimit: 64000, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "coding", "multilingual"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 2200,
  },
  {
    provider: "huggingface", modelId: "huggingface:Qwen/QwQ-32B",
    rawModelId: "Qwen/QwQ-32B",
    displayName: "Qwen QwQ 32B (HF)",
    tier: "REASONING", contextLimit: 32768, costInPer1k: 0, costOutPer1k: 0,
    capabilities: ["text", "reasoning", "coding"], privacyPolicy: "INTERNAL",
    latencyP50Ms: 1800,
  },
];

// ─── Unified Call Interface ───────────────────────────────────────────────

export interface ModelCallRequest {
  model: ProviderModel;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelCallResponse {
  model: string;
  provider: ProviderName;
  content: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}

// ─── Provider Check ───────────────────────────────────────────────────────

const PROVIDER_ENV_KEY: Record<ProviderName, string> = {
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  gemini: "GEMINI_API_KEY",
  huggingface: "HUGGINGFACE_API_KEY",
};

export function isProviderAvailable(provider: ProviderName): boolean {
  return !!process.env[PROVIDER_ENV_KEY[provider]];
}

export function getAvailableProviders(): ProviderName[] {
  return (["groq", "openrouter", "nvidia", "gemini", "huggingface"] as ProviderName[])
    .filter(isProviderAvailable);
}

export function getProviderEnvVar(provider: ProviderName): string {
  return PROVIDER_ENV_KEY[provider];
}

// ─── Unified Model Call ──────────────────────────────────────────────────

export async function callProviderModel(req: ModelCallRequest): Promise<ModelCallResponse> {
  const start = Date.now();
  const { model, messages, maxTokens, temperature } = req;

  try {
    let content = "";
    let tokensIn = 0;
    let tokensOut = 0;

    switch (model.provider) {
      case "groq":
        content = await callGroq(model.rawModelId, messages, maxTokens, temperature);
        break;
      case "openrouter":
        content = await callOpenRouter(model.rawModelId, messages, maxTokens, temperature);
        break;
      case "nvidia":
        content = await callNvidia(model.rawModelId, messages, maxTokens, temperature);
        break;
      case "gemini":
        content = await callGemini(model.rawModelId, messages, maxTokens, temperature);
        break;
      case "huggingface":
        content = await callHuggingFace(model.rawModelId, messages, maxTokens, temperature);
        break;
      default:
        throw new Error(`Unknown provider: ${model.provider}`);
    }

    tokensIn = estimateTokens(messages.map(m => m.content).join("\n"));
    tokensOut = estimateTokens(content);
    const costUsd = (tokensIn / 1000) * model.costInPer1k + (tokensOut / 1000) * model.costOutPer1k;

    return {
      model: model.modelId, provider: model.provider, content, tokensIn, tokensOut, costUsd,
      latencyMs: Date.now() - start, success: true,
    };
  } catch (err: any) {
    return {
      model: model.modelId, provider: model.provider, content: "",
      tokensIn: 0, tokensOut: 0, costUsd: 0,
      latencyMs: Date.now() - start, success: false, error: err?.message ?? "unknown error",
    };
  }
}

// ─── True Token Streaming ───────────────────────────────────────────────
//
// Streams tokens as they arrive from the provider (OpenAI-compatible SSE
// for Groq/OpenRouter/NVIDIA/HuggingFace, Gemini streamGenerateContent).
// The onToken callback is invoked for each delta — the UI sees tokens
// in real-time instead of waiting for the full response.
//
// Falls back to non-streaming if the provider's streaming endpoint fails.

export interface StreamingCallRequest extends ModelCallRequest {
  onToken?: (delta: string) => void;
}

export async function callProviderModelStreaming(req: StreamingCallRequest): Promise<ModelCallResponse> {
  const start = Date.now();
  const { model, messages, maxTokens, temperature, onToken } = req;

  try {
    let content = "";

    switch (model.provider) {
      case "groq":
      case "openrouter":
      case "nvidia":
      case "huggingface":
        // All 4 use OpenAI-compatible chat completions with stream:true
        content = await callOpenAICompatibleStreaming(model.provider, model.rawModelId, messages, maxTokens, temperature, onToken);
        break;
      case "gemini":
        content = await callGeminiStreaming(model.rawModelId, messages, maxTokens, temperature, onToken);
        break;
      default:
        throw new Error(`Unknown provider: ${model.provider}`);
    }

    const tokensIn = estimateTokens(messages.map(m => m.content).join("\n"));
    const tokensOut = estimateTokens(content);
    const costUsd = (tokensIn / 1000) * model.costInPer1k + (tokensOut / 1000) * model.costOutPer1k;

    return {
      model: model.modelId, provider: model.provider, content, tokensIn, tokensOut, costUsd,
      latencyMs: Date.now() - start, success: true,
    };
  } catch (err: any) {
    return {
      model: model.modelId, provider: model.provider, content: "",
      tokensIn: 0, tokensOut: 0, costUsd: 0,
      latencyMs: Date.now() - start, success: false, error: err?.message ?? "unknown error",
    };
  }
}

/** OpenAI-compatible streaming (Groq, OpenRouter, NVIDIA, HuggingFace router).
 *  Parses SSE lines: `data: {"choices":[{"delta":{"content":"..."}}]}` */
async function callOpenAICompatibleStreaming(
  provider: ProviderName,
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  temperature?: number,
  onToken?: (delta: string) => void,
): Promise<string> {
  const endpoints: Record<ProviderName, string> = {
    groq: "https://api.groq.com/openai/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
    huggingface: "https://router.huggingface.co/v1/chat/completions",
    gemini: "", // not used here
  };
  const envKeys: Record<ProviderName, string> = {
    groq: "GROQ_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    nvidia: "NVIDIA_API_KEY",
    huggingface: "HUGGINGFACE_API_KEY",
    gemini: "",
  };
  const key = process.env[envKeys[provider]];
  if (!key) throw new Error(`${envKeys[provider]} not configured`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://cirkle-brain-ai.vercel.app";
    headers["X-Title"] = "Cirkle Brain AI";
  }

  const resp = await fetch(endpoints[provider], {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.7,
      stream: true,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!resp.ok) throw new Error(`${provider} ${resp.status}: ${await safeText(resp)}`);
  if (!resp.body) throw new Error(`${provider} returned no body for streaming`);

  // Parse SSE stream
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE lines (delimited by \n\n)
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          content += delta;
          onToken?.(delta);
        }
      } catch {
        // Skip unparseable chunks (keepalive, partial JSON, etc.)
      }
    }
  }
  return content;
}

/** Gemini streaming via streamGenerateContent endpoint. */
async function callGeminiStreaming(
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  temperature?: number,
  onToken?: (delta: string) => void,
): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not configured");

  const systemPrompt = messages.find(m => m.role === "system")?.content ?? "";
  const userMessages = messages.filter(m => m.role !== "system");
  const contents = userMessages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        generationConfig: {
          maxOutputTokens: maxTokens ?? 4096,
          temperature: temperature ?? 0.7,
        },
      }),
      signal: AbortSignal.timeout(45000),
    },
  );
  if (!resp.ok) throw new Error(`Gemini stream ${resp.status}: ${await safeText(resp)}`);
  if (!resp.body) throw new Error("Gemini returned no body for streaming");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (delta) {
          content += delta;
          onToken?.(delta);
        }
      } catch {
        // Skip unparseable chunks
      }
    }
  }
  return content;
}

// ─── Provider Implementations ────────────────────────────────────────────

async function callGroq(
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not configured");
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.7,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Groq ${resp.status}: ${await safeText(resp)}`);
  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content ?? "";
}

async function callOpenRouter(
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://cirkle-brain-ai.vercel.app",
      "X-Title": "Cirkle Brain AI",
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.7,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${await safeText(resp)}`);
  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content ?? "";
}

async function callNvidia(
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY not configured");
  const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.7,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`NVIDIA ${resp.status}: ${await safeText(resp)}`);
  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content ?? "";
}

async function callGemini(
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not configured");
  // Gemini uses a different API format: split system instruction from contents.
  const systemPrompt = messages.find(m => m.role === "system")?.content ?? "";
  const userMessages = messages.filter(m => m.role !== "system");

  const contents = userMessages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        generationConfig: {
          maxOutputTokens: maxTokens ?? 4096,
          temperature: temperature ?? 0.7,
        },
      }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await safeText(resp)}`);
  const data = await resp.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function callHuggingFace(
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  const key = process.env.HUGGINGFACE_API_KEY;
  if (!key) throw new Error("HUGGINGFACE_API_KEY not configured");
  // Use the Hugging Face router (OpenAI-compatible). The legacy
  // api-inference.huggingface.co endpoint is deprecated.
  const resp = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.7,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!resp.ok) throw new Error(`HF ${resp.status}: ${await safeText(resp)}`);
  const data = await resp.json() as any;
  // Some HF chat models emit a separate "reasoning" field before content.
  const content = data.choices?.[0]?.message?.content ?? "";
  const reasoning = data.choices?.[0]?.message?.reasoning ?? "";
  if (content) return content;
  if (reasoning) return reasoning;
  return "";
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

async function safeText(resp: Response): Promise<string> {
  try {
    const t = await resp.text();
    return t.slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

/**
 * Get the best available model for a given tier + task.
 * Tries each available provider in priority order.
 */
export function getBestModelForTier(tier: "FAST" | "BALANCED" | "REASONING" | "SPECIALIST"): ProviderModel | null {
  const available = getAvailableProviders();
  const candidates = PROVIDER_MODELS.filter(m =>
    m.tier === tier && available.includes(m.provider)
  );
  if (candidates.length === 0) return null;
  // Sort by latency (fastest first), then by cost (cheapest first)
  candidates.sort((a, b) => a.latencyP50Ms - b.latencyP50Ms || a.costOutPer1k - b.costOutPer1k);
  return candidates[0];
}

/**
 * Get fallback chain: if the primary model fails, try the next available
 * model in the same tier from a different provider.
 */
export function getFallbackChain(tier: "FAST" | "BALANCED" | "REASONING" | "SPECIALIST"): ProviderModel[] {
  const available = getAvailableProviders();
  const candidates = PROVIDER_MODELS.filter(m =>
    m.tier === tier && available.includes(m.provider)
  );
  candidates.sort((a, b) => a.latencyP50Ms - b.latencyP50Ms || a.costOutPer1k - b.costOutPer1k);
  return candidates;
}

/**
 * Lookup a ProviderModel by its canonical id ("provider:raw-model").
 */
export function getModelById(modelId: string): ProviderModel | null {
  return PROVIDER_MODELS.find(m => m.modelId === modelId) ?? null;
}
