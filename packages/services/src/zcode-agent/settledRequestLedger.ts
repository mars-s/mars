/**
 * Removal of an in-flight request from a pending-request ledger once it has been
 * answered.
 *
 * WHY THIS EXISTS AS ITS OWN FUNCTION
 *
 * A pending-request map exists so an explicit cancel or a client disposal can
 * find a resolution that is still running. Its cost is that every request that
 * lands in it has to leave again, and the only thing that guarantees that is one
 * call site. A four line conditional buried in a `.finally()` inside a 3000 line
 * service is not something a test can reach, so the rule is named, documented
 * and proven here instead: the caller runs it on the completion path, and this
 * file is the statement of what "completion" means for the ledger.
 *
 * The rule is compare-then-delete rather than delete, because a request can be
 * re-registered under the same key: the agent re-sends a business requestId to
 * recover a lost protocol id, and a slow completion of the earlier attempt must
 * not evict the newer pending request that now answers the caller's wait.
 */
export function forgetSettledRequest<V>(pending: Map<string, V>, key: string, settled: V): void {
  if (pending.get(key) === settled) {
    pending.delete(key);
  }
}
