# Agent Diagnostics

This is the quickest path for an AI coding agent to diagnose request routing,
session affinity, retries, and unexpected token usage in a running dario
proxy. The endpoints are intended for local inspection and return bounded,
redacted data.

## First response

Confirm the proxy is serving, then collect both views from the same time
window. `limit` is newest-first and is capped by the proxy's configured
retention limit (512 entries by default). If `DARIO_API_KEY` is configured,
the same key is required by these endpoints.

```bash
BASE=http://127.0.0.1:3456
PRIVATE_DIR=$(mktemp -d)
chmod 700 "$PRIVATE_DIR"
AUTH=()
API_KEY=${DARIO_API_KEY:-$(jq -r '.apiKey // empty' "$HOME/.dario/config.json" 2>/dev/null)}
if [[ -n "$API_KEY" ]]; then AUTH=(-H "x-api-key: $API_KEY"); fi

curl -fsS "${AUTH[@]}" "$BASE/debug/requests?limit=50" | jq > "$PRIVATE_DIR/requests.json"
curl -fsS "${AUTH[@]}" "$BASE/routing/trace?limit=50" | jq > "$PRIVATE_DIR/routing.json"
```

The equivalent CLI command prints a human-readable routing summary; use
`--json` when an agent needs to parse it:

```bash
dario routing --limit=50
dario routing --limit=50 --json
```

`/debug/requests` is deliberately loopback-only, including when an API key is
present. `/routing/trace` contains no request text and is available to either
a direct loopback caller or an authenticated caller when a key is configured.
Do not expose either route through a public reverse proxy. Delete
`$PRIVATE_DIR` after the investigation.

## Request records

`/debug/requests` returns `{ generatedAt, retained, capacity, file, entries }`.
Each `entries[]` item is one client request, newest first:

| Field | Meaning |
| --- | --- |
| `req`, `ts`, `method`, `path`, `model` | Local request sequence, timestamp, HTTP route, and model. |
| `initialAccount`, `account` | Account selected initially and account that completed the request. A difference indicates failover. |
| `status`, `outcome`, `error`, `latencyMs` | Client-visible result and terminal diagnostic. |
| `upstreamAttempts`, `recoveryPasses`, `failoverCount`, `retryReasons` | Number and cause of upstream retries. More than one attempt is meaningful even when the final status is `200`. |
| `selectionReason` | Why the account was chosen, such as `affinity-hit`, `affinity-new`, `affinity-rebind`, `headroom`, or `round-robin`. |
| `affinityResult`, `affinitySource`, `affinityFingerprint` | Sticky-session result and the selected identity source. The fingerprint is salted per process and is not the raw session ID. |
| `affinitySignals` | Candidate identity signals. `selected` marks the signal used; `bindingEligible: false` means diagnostic-only and it cannot create a sticky binding. |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreateTokens` | Usage returned by the upstream response. Cache values are separate from ordinary input/output tokens. |
| `bodyBytes`, `bodyFingerprint`, `semanticFingerprint` | Exact-body size/hash and normalized-content hash. Hashes correlate entries only within the current proxy process. |
| `inputPreview`, `outputPreview` | Bounded, redacted text for identifying the calling client and spotting duplicate work. Tool arguments/results are omitted. |
| `inputChars`, `outputChars`, `inputTruncated`, `outputTruncated` | Original text size and whether the stored preview was clipped. |
| `client` | Best-effort client detector (for example, Claude Code or an OpenAI-compatible client). |

The persisted debug file is configured with `DARIO_DEBUG_LOG_FILE`; the
default request capacity is 512 and `DARIO_DEBUG_LOG_LIMIT` can lower or raise
it up to the built-in cap. Entries age out FIFO. The file is written with mode
`0600`.

## Routing records

`/routing/trace` returns a report with `pool`, aggregate `counts`, a concise
`diagnosis`, and `events[]`. Use the report before guessing that round-robin
is broken:

```bash
jq '.diagnosis, .counts, .events[:10]' "$PRIVATE_DIR/routing.json"
```

For each event, inspect:

- `selected` and `initialSelected`: the account chosen and whether a later
  failover changed it.
- `strategy` and `cursor.before`/`cursor.after`: the pool strategy and cursor
  movement for a new selection.
- `selectionReason`: `affinity-hit` intentionally stays on an existing
  binding; `affinity-new` creates one and consumes the strategy cursor;
  `affinity-rebind` replaces an unavailable binding; `affinity-disabled`
  means pure pool rotation; `no-eligible-account` means no account could serve
  the model.
- `affinity.result`: `hit`, `new`, `rebind`, `none`, or `disabled`.
- `affinity.source` and `affinity.signals`: which header/body identity was
  used. Signals marked diagnostic-only do not bind a session.
- `candidates`: eligibility, model-family restrictions, headroom, and request
  counts for each account.
- `failovers`, `released`, `status`, and `latencyMs`: account changes and why a
  lease was released.

## Diagnosis recipes

### One account appears fully loaded

1. Compare `events[].selected` counts and `events[].affinity.result`.
2. If most events are `affinity-hit` with one fingerprint, the behavior is
   intentional: one session is being reused. A new terminal must produce a
   different binding-eligible signal.
3. If multiple fingerprints are `affinity-new` but the same account is chosen,
   inspect `pool.candidates[].selectionEligible`, `reason`, and headroom. The
   other account may be below its model-family floor or restricted by plan.
4. If the report says `single-affinity-key`, inspect the `affinity.signals`
   source. An intermediary that copies one session header across terminals can
   make distinct clients look like one session; configure the body source only
   when stable body metadata is forwarded.

### Many nearly identical, expensive requests

1. Compare `bodyFingerprint` first. Repeated values are exact duplicate bodies;
   compare `req`, timestamps, `client`, and previews to identify the caller.
2. Compare `semanticFingerprint` next. Repetition here means equivalent text,
   but not necessarily identical tool state or headers.
3. Check `upstreamAttempts`, `recoveryPasses`, `failoverCount`, and
   `retryReasons`. A repeated request with attempts greater than one is a
   recovery/failover, not necessarily a client duplicate.
4. Check `status` and `outcome` before attributing token burn to retries. A
   successful response after a retry still records the attempts; terminal
   errors explain why the client may send the next request again.

### Cache and token columns

`cacheReadTokens` is the amount served from the prompt cache; it can exceed the
newly billed input tokens and is not evidence that dario duplicated the
request. `cacheCreateTokens` is the newly written cache portion. Compare both
with `inputTokens`, `outputTokens`, and the preview's `inputChars` before
estimating cost.

## TUI workflow

Open the **Hits** tab. Use `Up`/`Down` to select a request; the list shows
`in`, `out`, `cache read`, and `cache create` columns. Press `Enter` to open the
request inspector. In the inspector:

- `Up`/`Down` scroll one line.
- `PageUp`/`PageDown` scroll by a page-sized step.
- `Home`/`End` jump to the first/last line.
- `Esc` or `Enter` returns to the Hits list.

The inspector includes account/client, model/status/latency, billing and
upstream attempts, exact and semantic fingerprints, and bounded input/output
previews. A preview may say `aged out`; metadata remains available because
content is retained for fewer entries than the full request ring.

## Privacy and evidence handling

Diagnostics are for local debugging. Previews are bounded and redact common
credential-shaped values; tool arguments and tool results are intentionally
excluded. Affinity and request fingerprints are salted per process, so do not
expect them to correlate across a restart. Treat previews as sensitive local
data, keep the proxy on loopback, and remove exported files after the incident.
