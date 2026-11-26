import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export const PROVIDER_ID = "claude-code";
export const API_ID = "claude-code-stream-json";

export type ClaudeCodeModel = Model<typeof API_ID>;

export interface DiscoveredClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

// Pi exposes providers/all to extensions, but not individual generated model files.
const BUILTIN_ANTHROPIC_MODELS: Record<string, Model<"anthropic-messages">> = Object.fromEntries(
  getBuiltinModels("anthropic").map((model) => [model.id, model]),
);
// Anthropic 官方标准价（美元／百万 Token，5 分钟缓存写入）；Haiku 采用 ≤100k 输入档。
// https://platform.claude.com/docs/en/about-claude/pricing（2026-11-24 核对）
const ANTHROPIC_STANDARD_COST: Record<string, ClaudeCodeModel["cost"]> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
const NATIVE_ROUTE_BY_ID = new Map<string, string>();
const NATIVE_TOOL_CHANGES_BY_ID = new Map<string, boolean>();
const ADAPTIVE_THINKING_BY_ID = new Map<string, boolean>();
const DISABLED_THINKING_BY_ID = new Map<string, boolean>();

const FALLBACK_DISCOVERY: DiscoveredClaudeModel[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-fable-5-2",
    resolvedModel: "claude-fable-5-2",
    displayName: "Fable 5.2",
    description: "Fable 5.2 · Most capable for the hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "Sonnet 5.5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    displayName: "Haiku 5.5",
    description: "Haiku 5.5 · Fastest for quick answers",
    supportsEffort: true,
    supportsAdaptiveThinking: true,
  },
];

const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-2",
};

function withoutContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/u, "");
}

function canonicalModelId(info: DiscoveredClaudeModel): string {
  if (info.value === "default") return "default";
  return withoutContextSuffix(info.resolvedModel || ALIASES[withoutContextSuffix(info.value)] || info.value);
}

function fallbackModel(info: DiscoveredClaudeModel, id: string): ClaudeCodeModel {
  const supported = info.supportedEffortLevels;
  const thinkingLevelMap = supported?.length
    ? (Object.fromEntries(supported.map((level) => [level, level])) as ClaudeCodeModel["thinkingLevelMap"])
    : undefined;
  return {
    id,
    name: `${info.displayName} (Claude Code)`,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-code",
    reasoning: info.supportsAdaptiveThinking === true || info.supportsEffort === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: /\b1M context\b/iu.test(info.description) ? 1_000_000 : 200_000,
    maxTokens: 64_000,
  };
}

function fromBuiltin(info: DiscoveredClaudeModel, id: string, builtin: Model<"anthropic-messages">): ClaudeCodeModel {
  const {
    api: _api,
    provider: _provider,
    baseUrl: _baseUrl,
    compat: _compat,
    ...metadata
  } = builtin;
  return {
    ...metadata,
    id,
    name: id === "default" ? `Default (${builtin.name})` : builtin.name,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-code",
  };
}

/** Convert a Claude Code catalog row into Pi's built-in Anthropic naming and pricing. */
export function modelFromDiscovery(info: DiscoveredClaudeModel): ClaudeCodeModel {
  const id = canonicalModelId(info);
  const builtinId = id === "default" ? withoutContextSuffix(info.resolvedModel || "") : id;
  const builtin = BUILTIN_ANTHROPIC_MODELS[builtinId];
  NATIVE_ROUTE_BY_ID.set(id, info.value);
  NATIVE_TOOL_CHANGES_BY_ID.set(id, builtin?.compat?.supportsMidConvoToolChanges === true);
  ADAPTIVE_THINKING_BY_ID.set(id, info.supportsAdaptiveThinking === true);
  DISABLED_THINKING_BY_ID.set(
    id,
    // Pi marks models that reject `thinking.type: disabled` with `off: null`. Unknown
    // adaptive models are assumed to be newer and therefore unable to disable thinking.
    builtin ? builtin.thinkingLevelMap?.off !== null : info.supportsAdaptiveThinking !== true,
  );
  const model = builtin ? fromBuiltin(info, id, builtin) : fallbackModel(info, id);
  const cost = Object.hasOwn(ANTHROPIC_STANDARD_COST, builtinId) ? ANTHROPIC_STANDARD_COST[builtinId] : undefined;
  return cost ? { ...model, cost, contextWindow: 1_000_000, maxTokens: 128_000 } : model;
}

export const CLAUDE_CODE_MODELS: ClaudeCodeModel[] = FALLBACK_DISCOVERY.map(modelFromDiscovery);

export function nativeModel(model: string): string {
  const direct = NATIVE_ROUTE_BY_ID.get(model);
  if (direct) return direct;
  if (model === "default") return model;
  const canonical = canonicalRoute(model);
  return model.endsWith("[1m]") ? `${canonical}[1m]` : canonical;
}

function canonicalRoute(model: string): string {
  const withoutSuffix = withoutContextSuffix(model);
  return ALIASES[withoutSuffix] ?? withoutSuffix;
}

/** Whether Claude Code reports adaptive thinking for this model. Unknown models are assumed to support it. */
export function supportsAdaptiveThinking(model: string): boolean {
  const canonical = canonicalRoute(model);
  return ADAPTIVE_THINKING_BY_ID.get(model) ?? ADAPTIVE_THINKING_BY_ID.get(canonical) ?? true;
}

/** Whether the API accepts `thinking: { type: "disabled" }` for this model. */
export function supportsDisabledThinking(model: string): boolean {
  const canonical = canonicalRoute(model);
  const known = DISABLED_THINKING_BY_ID.get(model) ?? DISABLED_THINKING_BY_ID.get(canonical);
  if (known !== undefined) return known;
  const builtin = BUILTIN_ANTHROPIC_MODELS[canonical];
  return builtin ? builtin.thinkingLevelMap?.off !== null : !supportsAdaptiveThinking(model);
}

/** Whether Anthropic currently accepts native mid-conversation tool blocks for this route. */
export function supportsNativeToolChanges(model: string): boolean {
  const canonical = canonicalRoute(model);
  return (
    NATIVE_TOOL_CHANGES_BY_ID.get(model) ??
    NATIVE_TOOL_CHANGES_BY_ID.get(canonical) ??
    BUILTIN_ANTHROPIC_MODELS[canonical]?.compat?.supportsMidConvoToolChanges === true
  );
}

export function modelForDiscoveredRoute(route: string, label?: string): ClaudeCodeModel | undefined {
  const canonical = withoutContextSuffix(ALIASES[withoutContextSuffix(route)] ?? route);
  const known = CLAUDE_CODE_MODELS.find((model) => model.id === canonical);
  return known ? { ...known, name: label ? `${label} (Claude Code)` : known.name } : undefined;
}
