/**
 * In-memory `navigator.locks` fake for unit/component tests.
 *
 * `src/undo/lock.ts` serializes every undo replay/discard path through ONE
 * extension-wide exclusive Web Lock (`navigator.locks.request`). Node has no
 * Web Locks and jsdom does not implement them either, so without a fake the
 * production wiring would silently take the "lock unavailable" refusal path
 * in every test instead of exercising the real serialization contract.
 *
 * Contract (mirrors the platform contract for the slice the extension uses):
 *  - Requests are granted FIFO per lock name.
 *  - `exclusive` requests never overlap: a name grants one exclusive holder
 *    at a time, and no `shared` holder may be active alongside it.
 *  - `shared` requests may overlap each other, never an exclusive one.
 *  - A holder is released when the callback's returned promise settles (for a
 *    callback returning a plain value, in the next microtask); the request
 *    promise then settles with the callback's outcome. Granting invokes the
 *    callback in a microtask — the platform grants in a separate task, so a
 *    request made in the same turn still queues behind the current grant.
 *  - `ifAvailable: true` never queues: the callback gets `null` immediately
 *    (synchronously) when the lock cannot be granted at request time.
 *  - `signal` aborts settle the request with the signal's reason: a pending
 *    request leaves the queue, a request aborted before its callback runs
 *    releases the lock without invoking the callback. An abort AFTER the
 *    callback started is not simulated — the callback owns the critical
 *    section until its promise settles (the platform keeps that guarantee
 *    too).
 *  - `steal: true` is not implemented; it throws a `NotSupportedError`
 *    instead of pretending to steal.
 *
 * `inspect()` is the synchronous test probe (`query()` is the platform async
 * shape): it reports holders, the pending queue, and the highest simultaneous
 * holder count seen, so tests can assert serialization directly.
 *
 * `installWebLocksFake()` publishes the fake as `navigator.locks`;
 * `removeWebLocksFake()` publishes `undefined` instead, which is the
 * "runtime has no Web Locks" case the refusal tests need.
 */

/** A queued or granted request. */
interface PendingLockRequest {
  name: string;
  mode: LockMode;
  callback: LockGrantedCallback<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** True once the request promise has been settled (or its callback ended). */
  settled: boolean;
  /** True while this request holds the lock (set at grant, cleared at release). */
  held: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface LockState {
  /** Mode of the currently granted holders; `null` when the lock is free. */
  mode: LockMode | null;
  /** Number of granted holders under `mode` (1 for exclusive, n for shared). */
  holders: number;
  queue: PendingLockRequest[];
}

/** Synchronous snapshot of the fake's state, for test assertions. */
export interface WebLockInspection {
  /** Names with at least one granted holder. */
  held: { name: string; mode: LockMode; holders: number }[];
  /** Queued requests, FIFO per name. */
  pending: { name: string; mode: LockMode }[];
  /** Total requests granted since construction. */
  grants: number;
  /** Highest simultaneous holder count observed for any single name. */
  maxHolders: number;
}

const CLIENT_ID = "web-locks-fake";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** See the module header for the implemented contract. */
export class WebLocksFake implements LockManager {
  private readonly states = new Map<string, LockState>();
  private grantCount = 0;
  private maxHolderCount = 0;

  private state(name: string): LockState {
    let state = this.states.get(name);
    if (state === undefined) {
      state = { mode: null, holders: 0, queue: [] };
      this.states.set(name, state);
    }
    return state;
  }

  private grantable(name: string, mode: LockMode): boolean {
    const state = this.state(name);
    if (state.holders === 0) return true;
    return mode === "shared" && state.mode === "shared";
  }

  /** Synchronous counterpart of {@link query}, for test assertions. */
  inspect(): WebLockInspection {
    const held: WebLockInspection["held"] = [];
    const pending: WebLockInspection["pending"] = [];
    for (const [name, state] of this.states) {
      if (state.holders > 0 && state.mode !== null) {
        held.push({ name, mode: state.mode, holders: state.holders });
      }
      for (const request of state.queue) {
        pending.push({ name, mode: request.mode });
      }
    }
    return {
      held,
      pending,
      grants: this.grantCount,
      maxHolders: this.maxHolderCount,
    };
  }

  query(): Promise<LockManagerSnapshot> {
    const { held, pending } = this.inspect();
    return Promise.resolve({
      held: held.map(({ name, mode }) => ({ name, mode, clientId: CLIENT_ID })),
      pending: pending.map(({ name, mode }) => ({ name, mode, clientId: CLIENT_ID })),
    });
  }

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<Awaited<T>>;
  request<T>(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<Awaited<T>>;
  request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> {
    const options: LockOptions =
      typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback =
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (typeof callback !== "function") {
      throw new TypeError("navigator.locks.request requires a callback.");
    }
    if (options.steal === true) {
      throw new DOMException(
        "WebLocksFake does not implement `steal`.",
        "NotSupportedError",
      );
    }
    const mode: LockMode = options.mode ?? "exclusive";

    const promise = new Promise<unknown>((resolve, reject) => {
      const request: PendingLockRequest = {
        name,
        mode,
        callback: callback as LockGrantedCallback<unknown>,
        resolve,
        reject,
        settled: false,
        held: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };

      if (options.ifAvailable === true) {
        if (this.grantable(name, mode)) {
          this.grant(request);
        } else {
          // Never queued, never granted, never released: the callback gets
          // `null` immediately, exactly like the platform's opportunistic
          // request.
          request.settled = true;
          try {
            resolve(callback(null));
          } catch (cause) {
            reject(cause);
          }
        }
        return;
      }

      const signal = options.signal;
      if (signal?.aborted === true) {
        request.settled = true;
        reject(abortReason(signal));
        return;
      }
      if (signal !== undefined) {
        request.onAbort = () => this.abortPending(request, signal);
        signal.addEventListener("abort", request.onAbort);
      }
      this.state(name).queue.push(request);
      this.pump(name);
    });

    return promise as Promise<Awaited<T>>;
  }

  /**
   * Drop a request that is still queued when its signal aborts, then let the
   * next grantable request through.
   */
  private abortPending(request: PendingLockRequest, signal: AbortSignal): void {
    if (request.settled) return;
    const state = this.state(request.name);
    const index = state.queue.indexOf(request);
    if (index < 0) return; // already granted — the callback owns the lock
    state.queue.splice(index, 1);
    request.settled = true;
    if (request.onAbort !== undefined) {
      signal.removeEventListener("abort", request.onAbort);
    }
    request.reject(abortReason(signal));
    this.pump(request.name);
  }

  /** Grant the next queued request whenever the head is compatible. */
  private pump(name: string): void {
    const state = this.state(name);
    while (state.queue.length > 0) {
      const head = state.queue[0];
      if (head === undefined) return;
      if (head.settled) {
        state.queue.shift();
        continue;
      }
      if (!this.grantable(name, head.mode)) return;
      state.queue.shift();
      this.grant(head);
    }
  }

  private grant(request: PendingLockRequest): void {
    const state = this.state(request.name);
    state.mode = request.mode;
    state.holders += 1;
    request.held = true;
    this.grantCount += 1;
    if (state.holders > this.maxHolderCount) {
      this.maxHolderCount = state.holders;
    }
    // The platform grants a request in a separate task; the fake uses a
    // microtask so a sibling request made in the same turn (same context or
    // another one) still queues behind this grant, while tests stay
    // deterministic.
    queueMicrotask(() => {
      if (request.signal?.aborted === true) {
        // Aborted between queueing and running: the platform releases the
        // lock without invoking the callback.
        request.settled = true;
        if (request.onAbort !== undefined) {
          request.signal.removeEventListener("abort", request.onAbort);
        }
        request.reject(abortReason(request.signal));
        this.release(request);
        return;
      }
      this.invokeCallback(request, { name: request.name, mode: request.mode });
    });
  }

  private invokeCallback(request: PendingLockRequest, lock: Lock | null): void {
    let outcome: unknown;
    try {
      outcome = request.callback(lock);
    } catch (cause) {
      this.settle(request, () => request.reject(cause));
      return;
    }
    Promise.resolve(outcome).then(
      (value) => this.settle(request, () => request.resolve(value)),
      (error: unknown) => this.settle(request, () => request.reject(error)),
    );
  }

  /** Release the holder, then settle its request promise. */
  private settle(request: PendingLockRequest, settlePromise: () => void): void {
    if (request.settled) return;
    request.settled = true;
    if (request.onAbort !== undefined && request.signal !== undefined) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
    this.release(request);
    settlePromise();
  }

  /** Drop this request's hold, then let the next grantable request through. */
  private release(request: PendingLockRequest): void {
    if (!request.held) return;
    request.held = false;
    const state = this.state(request.name);
    state.holders = Math.max(state.holders - 1, 0);
    if (state.holders === 0) state.mode = null;
    this.pump(request.name);
  }
}

/** Build a fresh fake — one empty lock-name registry. */
export function createWebLocksFake(): WebLocksFake {
  return new WebLocksFake();
}

let installed: WebLocksFake | undefined;

/**
 * Publish `fake` (a fresh one by default) as `navigator.locks`. Node's
 * `navigator` and jsdom's `window.navigator` both exist but expose no
 * `locks`, so the fake is defined as an own property (configurable, so tests
 * and {@link removeWebLocksFake} can replace it).
 */
export function installWebLocksFake(
  fake: WebLocksFake = createWebLocksFake(),
): WebLocksFake {
  const target = globalThis as { navigator?: object };
  const navigatorObject = target.navigator;
  if (navigatorObject === undefined) {
    Object.defineProperty(target, "navigator", {
      value: { locks: fake },
      configurable: true,
      writable: true,
    });
  } else {
    Object.defineProperty(navigatorObject, "locks", {
      value: fake,
      configurable: true,
      writable: true,
    });
  }
  installed = fake;
  return fake;
}

/**
 * Publish `undefined` as `navigator.locks` — the "this runtime has no Web
 * Locks" case the undo lock must refuse typed rather than guess.
 */
export function removeWebLocksFake(): void {
  const navigatorObject = (globalThis as { navigator?: object }).navigator;
  if (navigatorObject !== undefined) {
    Object.defineProperty(navigatorObject, "locks", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }
  installed = undefined;
}

/** The fake installed by {@link installWebLocksFake}, when one is installed. */
export function currentWebLocksFake(): WebLocksFake | undefined {
  return installed;
}
