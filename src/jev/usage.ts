/**
 * Per-run usage accumulator for the Jev client (spec FR3, PROJECT_PLAN.md
 * §8.3). `UsageMeter` sums token counts and reported USD cost across batch
 * responses and records the versioned model ids seen. It is pure and holds
 * state in memory only — nothing is persisted.
 */

/**
 * One response's `usage` block, shaped exactly like `SystemOneResponse.usage`
 * so `meter.add(parsed.usage, parsed.model)` works without a mapping step.
 */
export interface UsageEntry {
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** USD cost — reported by OpenRouter only. */
  readonly cost?: number;
}

export class UsageMeter {
  #inputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;
  /** At least one entry reported a `cost`. */
  #sawCost = false;
  /** At least one entry did not report a `cost`. */
  #missedCost = false;
  #entries = 0;
  readonly #models: string[] = [];
  readonly #seenModels = new Set<string>();

  /**
   * Fold one response's usage into the totals. `model` is optional; when
   * given it is recorded once, in first-seen order.
   */
  add(usage: UsageEntry, model?: string): void {
    this.#entries += 1;
    this.#inputTokens += usage.input_tokens;
    this.#outputTokens += usage.output_tokens;
    if (usage.cost === undefined) {
      this.#missedCost = true;
    } else {
      this.#sawCost = true;
      this.#costUsd += usage.cost;
    }
    if (model !== undefined && !this.#seenModels.has(model)) {
      this.#seenModels.add(model);
      this.#models.push(model);
    }
  }

  /** Total `input_tokens` across all added entries. */
  get inputTokens(): number {
    return this.#inputTokens;
  }

  /** Total `output_tokens` across all added entries. */
  get outputTokens(): number {
    return this.#outputTokens;
  }

  /**
   * Summed USD cost over the entries that reported one; `undefined` when no
   * entry reported a cost, so callers can distinguish "no cost data" from a
   * genuine $0.00.
   */
  get costUsd(): number | undefined {
    return this.#sawCost ? this.#costUsd : undefined;
  }

  /**
   * Whether every added entry reported a cost. `false` for an empty meter —
   * "complete" is only meaningful once at least one response was counted.
   */
  get costComplete(): boolean {
    return this.#entries > 0 && !this.#missedCost;
  }

  /** Unique model ids seen, in first-seen order (a snapshot copy). */
  get models(): readonly string[] {
    return [...this.#models];
  }
}
