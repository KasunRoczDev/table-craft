/**
 * Message counts of the topics sessions have listed or described, so `classify` and `inspect`,
 * which get no session, can tell a big topic (decision 10). Keyed by name across datasources, the
 * largest count wins: a false "costly" mark costs a glance, a missed one a long read.
 */
const KNOWN_SIZES = new Map<string, bigint>();
/** Topics remembered at most, so a cluster with very many topics cannot grow this without bound. */
const MAX_REMEMBERED = 100_000;

export function noteTopicSize(topic: string, messages: string | null): void {
  if (messages === null) return;
  const count = BigInt(messages);
  const known = KNOWN_SIZES.get(topic);
  if (known !== undefined && known >= count) return;
  if (known === undefined && KNOWN_SIZES.size >= MAX_REMEMBERED) return;
  KNOWN_SIZES.set(topic, count);
}

/** The largest message count seen for `topic`; null when no session has listed it. */
export function knownTopicSize(topic: string): bigint | null {
  return KNOWN_SIZES.get(topic) ?? null;
}
