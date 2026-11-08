/**
 * Minimal structural types for the parts of OMP's extension API this plugin uses.
 * OMP ships as a compiled binary, so `@oh-my-pi/pi-coding-agent` is not resolvable here;
 * every shape below was confirmed against omp 18.18 with probe extensions.
 */

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolCallBlock | { type: string; [key: string]: unknown };

export interface AgentMessage {
	role: string;
	content?: ContentBlock[] | string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: Record<string, unknown>;
	timestamp?: number;
	[key: string]: unknown;
}

/** One persisted journal entry as returned by `sessionManager.getBranch()`. */
export interface BranchEntry {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
	message?: AgentMessage;
	[key: string]: unknown;
}

export interface ModelDescriptor {
	id: string;
	provider: string;
	[key: string]: unknown;
}

export interface ExtensionUI {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

export interface ExtensionContext {
	cwd: string;
	hasUI: boolean;
	ui: ExtensionUI;
	sessionManager: { getBranch(): BranchEntry[] };
	models?: { current(): ModelDescriptor | undefined; resolve(spec: string): ModelDescriptor | undefined };
	agent?: { kind: "main" | "sub"; id: string; name: string; depth: number; parentId?: string };
	getContextUsage?(): ContextUsage | undefined;
	setTimeout?(fn: () => void, ms: number): unknown;
}

export interface ToolResultContent {
	content: TextBlock[];
	details?: unknown;
	isError?: boolean;
}

export interface ToolDefinition<P> {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	loadMode?: "essential" | "discoverable";
	approval?: "read" | "write" | "exec";
	/** Registered but inactive until the extension activates it with `setActiveTools()`. */
	defaultInactive?: boolean;
	execute(
		toolCallId: string,
		params: P,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: ToolResultContent) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<ToolResultContent>;
}

/** Zod-compatible builder injected as `pi.zod` (only the members used here). */
export interface ZodLike {
	object(shape: Record<string, unknown>): unknown;
	string(): ZodChain;
	number(): ZodChain;
	enum(values: readonly string[]): ZodChain;
	array(item: unknown): ZodChain;
}

export interface ZodChain {
	optional(): ZodChain;
	describe(text: string): ZodChain;
}

export interface SendMessageInput {
	customType: string;
	content: string;
	display?: boolean;
	attribution?: "user" | "agent";
}

export interface ExtensionAPI {
	zod: ZodLike;
	setLabel(label: string): void;
	on(event: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown): void;
	registerTool<P>(def: ToolDefinition<P>): void;
	registerCommand(
		name: string,
		def: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
	): void;
	registerFlag(name: string, def: { description: string; type: "string" | "boolean" }): void;
	getFlag(name: string): unknown;
	appendEntry(customType: string, data: unknown): void;
	sendMessage(
		message: SendMessageInput,
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; triggerTurn?: boolean },
	): void;
	getActiveTools(): string[];
	setActiveTools(names: string[]): Promise<void>;
}

/** Bun global available inside OMP's runtime (not under node tests). */
declare global {
	// eslint-disable-next-line no-var
	var Bun: { YAML: { parse(text: string): unknown } } | undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") out += block.text;
	}
	return out;
}
