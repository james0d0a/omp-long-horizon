import type { BranchEntry, ExtensionAPI, ExtensionContext, SendMessageInput, ToolDefinition } from "../src/omp.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

/** Chainable stand-in for `pi.zod`: schemas are opaque to these tests. */
const zodStub: ExtensionAPI["zod"] = new Proxy(
	{},
	{
		get: () => () => new Proxy({}, { get: (_t, _p, receiver) => () => receiver }),
	},
) as ExtensionAPI["zod"];

/** In-memory OMP session host: a journal branch, registered handlers/tools, and recorded actions. */
export class FakeOmp {
	readonly branch: BranchEntry[] = [];
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, ToolDefinition<never>>();
	readonly sent: SendMessageInput[] = [];
	readonly notices: string[] = [];
	activeTools = ["read", "bash", "edit", "write", "grep"];
	readonly flags = new Map<string, unknown>();
	#seq = 0;

	readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	api(): ExtensionAPI {
		return {
			zod: zodStub,
			setLabel: () => {},
			on: (event, handler) => this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]),
			registerTool: def => this.tools.set(def.name, def as ToolDefinition<never>),
			registerCommand: (name, def) => this.handlers.set(`command:${name}`, [(event, ctx) => def.handler(String(event.args), ctx)]),
			registerFlag: () => {},
			getFlag: name => this.flags.get(name),
			appendEntry: (customType, data) => {
				this.branch.push({ type: "custom", id: `c${++this.#seq}`, customType, data: structuredClone(data) });
			},
			sendMessage: message => {
				this.sent.push(message);
			},
			getActiveTools: () => [...this.activeTools],
			setActiveTools: async names => {
				this.activeTools = [...names];
			},
		};
	}

	ctx(kind: "main" | "sub" = "main"): ExtensionContext {
		return {
			cwd: this.cwd,
			hasUI: false,
			ui: { notify: message => this.notices.push(message), setStatus: () => {} },
			sessionManager: { getBranch: () => this.branch },
			agent: { kind, id: kind, name: kind, depth: 0 },
			getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		};
	}

	async emit(event: string, payload: Record<string, unknown> = {}, ctx = this.ctx()): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			const r = await handler({ type: event, ...payload }, ctx);
			if (r !== undefined) result = r;
		}
		return result;
	}

	command(args: string, ctx = this.ctx()): Promise<unknown> {
		return this.emit("command:horizon", { args }, ctx);
	}

	async callTool(name: string, params: unknown, ctx = this.ctx()) {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`no tool ${name}`);
		const id = `t${++this.#seq}`;
		this.message({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: params as Record<string, unknown> }] });
		const result = await tool.execute(id, params as never, undefined, undefined, ctx);
		this.message({ role: "toolResult", toolCallId: id, toolName: name, content: result.content, isError: result.isError === true });
		return result;
	}

	/** Simulates a model-issued exec tool call through the hooks the way OMP dispatches it. */
	async exec(command: string, isError: boolean, output = "", ctx = this.ctx()) {
		const id = `t${++this.#seq}`;
		this.message({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] });
		await this.emit("tool_result", { toolName: "bash", toolCallId: id, input: { command }, content: [{ type: "text", text: output }], isError }, ctx);
		this.message({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: output }], isError });
		await this.emit("turn_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash" }] } }, ctx);
	}

	message(message: Record<string, unknown>): void {
		this.branch.push({ type: "message", id: `m${++this.#seq}`, message: message as BranchEntry["message"] });
	}

	custom(type: string): Record<string, unknown>[] {
		return this.branch.filter(e => e.type === "custom" && e.customType === type).map(e => e.data as Record<string, unknown>);
	}
}
