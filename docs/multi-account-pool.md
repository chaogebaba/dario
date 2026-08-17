# The account pool

As of v5.0 the account pool is dario's one credential model. A plain `dario login` is a **pool of one** (materialized as `~/.dario/accounts/login.json` under the reserved `login` alias); adding accounts just makes it a pool of many. There's no separate single-account mode — a pool of one and a pool of many run the identical request path.

```bash
dario login                     # a pool of one
dario accounts add work         # now a pool of two
dario accounts add personal
dario accounts list
dario proxy
```

Your `dario login` credentials materialize into the pool automatically — on `dario login` itself, and again on `dario proxy` startup as a safety net. `~/.dario/credentials.json` is left in place; the back-fill is a one-way copy, never a move. If you run `dario accounts add <alias>` on top of a login-only setup, the `login` account is already in the pool, so you simply gain the new alias alongside it. Picking `login` as an explicit alias is your call — dario won't clobber it.

Each request picks the account with the highest headroom:

```
headroom = 1 - max(util_5h, util_7d)
```

The response's `anthropic-ratelimit-unified-*` headers are parsed back into the pool so the next selection sees fresh utilization. An account that returns a 429 enters a bounded, model-scoped exponential cooldown (honoring `Retry-After`) and is automatically eligible again; a quota reset also discards stale utilization. When every account is exhausted, requests queue for up to 60 seconds waiting for headroom to reappear. Plan restrictions still apply: Fable 5 is Max-only, while unrestricted families can use every eligible tier.

## Routing strategy

Headroom spreading is the default and stays the right call when every seat is equal. `--pool-strategy=round-robin` (env `DARIO_POOL_STRATEGY`, config `pool.strategy`) cycles cold bindings through eligible aliases in stable order, with an independent cursor per model family. `--pool-strategy=fill-first` flips to concentration: new conversations land on the **alphabetically-first** eligible seat until its headroom drains to the 2% floor, then spill to the next alias in line. Failover follows the configured selector and skips accounts in cooldown.

Two situations where that beats spreading:

- **Primary/backup seats.** A `z-backup` account stays completely untouched — fresh 5h and 7d windows — until `a-main` is actually drained. Headroom spreading would nibble at both from the first request.
- **Cache concentration.** Every fresh conversation lands where the prompt-cache pressure already is, so the spill seat's windows are fully fresh when the primary hits its wall.

Alias order is the operator's knob: name seats `1-main` / `2-overflow` to pick the fill order. Strategy only decides where **unbound** conversations land — sticky bindings (below) behave identically in both modes, and a conversation bound to a seat stays there until that seat is rejected, expiring, or under the floor.

## Session stickiness

Multi-turn agent sessions pin to one account for the life of the conversation, so the Anthropic prompt cache isn't destroyed by account rotation between turns.

**The problem.** Claude prompt cache is scoped to `{account × cache_control key}`. When the pool rotates a long agent conversation across accounts on headroom alone, turn 1 builds a cache entry on account A, turn 2 lands on account B and reads nothing from A's cache — paying full cache-create cost again. For a long agent session that's a **5–10× token-cost multiplier** on every turn after the first.

**The fix.** Dario mirrors the upstream selector's identity precedence: explicit Claude/Codex/session headers first, then body session IDs, Claude metadata, prompt-cache/conversation IDs, and finally a stable first-user-turn hash. Bindings are namespaced by model family, so a conversation switching Sonnet and Fable retains the right seat for each model. Subsequent turns re-use the bound account as long as it's still healthy (not cooling, token not near expiry, headroom > 2%). On 429 or transient 5xx failover, dario releases/rebinds the key so the next turn doesn't re-select the failed account. The default TTL is 1h in config (with a 2,000-entry cap and lazy cleanup). No client cooperation is required when no explicit identity exists.

## Pool-exhausted fallback

`--pool-fallback=<model>` (env `DARIO_POOL_FALLBACK`, config `poolFallback.model`) is a strictly opt-in escape hatch for when the whole pool is drained or cooling. With it set **and** an openai-compat backend configured (`dario backend add …`), an OpenAI-shape request (`/v1/chat/completions`) that the pool can't serve — at selection time, or after a mid-flight 429 with no peer left — is forwarded to that backend with the model swapped to `<model>`, instead of returning the 429/503.

Three deliberate limits:

- **OpenAI-shape only.** Anthropic-shape requests (`/v1/messages`) keep the error. dario translates Anthropic→OpenAI on the way out but has no OpenAI→Anthropic *response* translator, so a fallback there would corrupt the client's stream. Point Anthropic-native clients that want this at `/v1/chat/completions`, or leave the fallback off.
- **Never silent.** Every substituted response carries `x-dario-pool-fallback: <model>`. A quietly swapped model is exactly the surprise this project exists to avoid — check for the header if you need to know which requests fell back.
- **Empty pool still errors.** A pool with zero accounts is a setup mistake (`dario login` never ran); that returns the usual 503 rather than silently re-billing every request to another provider.

```bash
dario backend add openrouter --key=sk-or-... --base-url=https://openrouter.ai/api/v1
dario proxy --pool-fallback=openrouter/anthropic/claude-3.5-sonnet
```

## In-flight 429 failover

When a Claude request hits a 429 mid-flight, dario retries the *same request* against a different account before the client sees an error. The client sees one successful response; the pool cools the rejected model/account pair for a bounded interval and later admits it again. Combined with session stickiness, long agent runs survive pool-level exhaustion without dropping user-facing turns.

## Inspection

```bash
curl http://localhost:3456/accounts     # per-account utilization, claim, sticky bindings, status
curl http://localhost:3456/analytics    # per-account / per-model stats, burn rate, exhaustion predictions
```

Every request carries a `billingBucket` field (`subscription` / `subscription_fallback` / `extra_usage` / `api` / `unknown`) so you can see which bucket each request billed against and a `subscriptionPercent` headline number tells you at a glance whether dario is actually routing through your subscription or silently falling to API overage.
