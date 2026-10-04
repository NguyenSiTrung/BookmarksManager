/** Content-free abort classification shared by both outbound gates.
 * An aborted signal's reason is authoritative: fetch may reject a native
 * deadline with AbortError, or a caller abort with an arbitrary value.
 * Never read error messages or retain the caller/provider reason.
 */
export function classifyAbort(
  signal: AbortSignal | null | undefined,
  cause?: unknown,
): "timeout" | "aborted" | undefined {
  const reason = signal?.aborted ? signal.reason : cause;
  const name = typeof reason === "object" && reason !== null
    ? (reason as { name?: unknown }).name
    : undefined;
  if (name === "TimeoutError") return "timeout";
  if (signal?.aborted || name === "AbortError") return "aborted";
  return undefined;
}
