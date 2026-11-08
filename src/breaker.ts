export interface BreakerConfig {
	/** Failures of one Failure Signature within the window that trip the breaker. */
	threshold: number;
	/** Number of most recent exec steps considered. */
	window: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { threshold: 3, window: 8 };

interface ExecStep {
	signature: string;
	scriptSignature?: string;
	failed: boolean;
}
/**
 * Sliding window over exec steps. A Circuit Breaker Trip fires when one Failure Signature
 * fails `threshold` times within the last `window` exec steps with no success of that same
 * signature in between; other commands succeeding in between do not reset it. Calibrated on a
 * recorded lab run, where agents making progress through distinct errors of one command
 * interleave successes of it, while thrashing repeats the same failure. After a trip the
 * signature's history is cleared so one thrash trips once.
 */
export class FailureWindow {
	readonly #config: BreakerConfig;
	#steps: ExecStep[] = [];

	constructor(config: BreakerConfig = DEFAULT_BREAKER) {
		this.#config = config;
	}

	/** Records one exec step; returns the failure count for its signature when it trips. */
	record(signature: string, failed: boolean, scriptSignature?: string): number | undefined {
		if (!failed) {
			for (const step of this.#steps) {
				if (step.signature === signature || (step.scriptSignature && step.scriptSignature === signature)) {
					step.failed = false;
				}
			}
		}
		this.#steps.push({ signature, scriptSignature, failed });
		if (this.#steps.length > this.#config.window) this.#steps.splice(0, this.#steps.length - this.#config.window);
		if (!failed) return undefined;
		const failures = this.#steps.filter(s => s.failed && s.signature === signature).length;
		if (failures < this.#config.threshold) return undefined;
		this.#steps = this.#steps.filter(s => s.signature !== signature);
		return failures;
	}

	reset(): void {
		this.#steps = [];
	}
}
