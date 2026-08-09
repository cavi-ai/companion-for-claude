# Authentication & cost

Companion talks directly to Anthropic. There is no service in between, no account
with us, and no key of ours involved. You bring a credential; it's stored in this
vault's plugin data and used only for requests you trigger.

*Settings → Companion for Claude → Connection → Authentication*

## Three modes

### API key (default, recommended)

Paste an Anthropic API key from the
[Console](https://console.anthropic.com/settings/keys). It's sent as the
`x-api-key` header. This is the standard, community-store-safe path — the one to
pick unless you have a reason not to.

Usage bills to your Anthropic API account.

### Long-term OAuth token (subscription)

If you have a Claude subscription, you can bill usage to your plan instead of
buying API credits. Generate a long-term token with the Claude Code CLI:

```bash
claude setup-token
```

Paste the resulting `sk-ant-oat…` token. It's sent as `Authorization: Bearer`
along with `anthropic-beta: oauth-2025-04-20`.

Subscription tokens require the request to present as Claude Code: Companion
prepends Anthropic's Claude Code identity string as the first system block, with
your own system prompt after it. Wrong ordering returns a 429 `rate_limit_error`
that reads as "out of usage" while credits are unaffected. Companion handles the
ordering.

An OAuth token sent on `x-api-key` is rejected with 401. Companion selects the
header from the credential's shape, so pasting a token into the key field still
works.

### Import from the environment

Reads from the process environment, mirroring SDK precedence:

| Variable | Used as |
|---|---|
| `ANTHROPIC_API_KEY` | Checked first. Header scheme picked from its shape. |
| `ANTHROPIC_AUTH_TOKEN` | Used if no key. Always a `Bearer` credential — gateway tokens and subscription OAuth. |
| `ANTHROPIC_BASE_URL` | Base URL, unless overridden in settings. |

`ANTHROPIC_AUTH_TOKEN` never goes on `x-api-key` (that 401s), and the OAuth beta
header is attached only to genuine `sk-ant-oat…` tokens — a plain gateway bearer
token must not carry it.

## Base URL override

**API base URL** points any of the three modes at a gateway or proxy instead of
`https://api.anthropic.com`. Trailing slashes are normalized, so both
`https://gw.example.com` and `https://gw.example.com/` work.

An explicit setting wins over `ANTHROPIC_BASE_URL`.

## Verifying it works

Click **Save & test connection**. It sends a cheap request using Claude Haiku 4.5
as a probe model, so a connection test costs almost nothing. Failures come back as
actionable messages rather than raw HTTP errors.

## Models

*Settings → Companion for Claude → Connection → Model*

| Model | When |
|---|---|
| Claude Opus 4.8 | Most capable — deep reasoning, best artifacts |
| **Claude Sonnet 5** | Balanced default — fast and strong |
| Claude Haiku 4.5 | Fastest and cheapest — quick edits and Q&A |
| Claude Fable 5 | Claude 5 family |

**Custom model id** overrides the dropdown entirely, for a model id newer than
this build knows about or a gateway-specific name. You can also switch model per
message from the chat composer.

## Cost and caching

Companion never sends an empty model id and never silently upgrades your model, so
your bill has no surprises in it beyond the requests you made.

**Prompt caching** is on for repeated context, which is the single biggest lever on
cost for vault work — the same notes ride along with message after message.
Relative to the base input rate:

| Bucket | Rate |
|---|---|
| Fresh input | 1× |
| Cache write | 1.25× |
| **Cache read** | **0.1×** |

The context-window gauge and session cost estimate account for each bucket
separately, so what you see reflects what caching actually saved rather than
pricing every token as fresh input.

Other levers: route bulk work to a local model, or let the Auto backend keep you
running when usage runs out — see [local-models.md](local-models.md).

## Key safety

- The credential is stored in this vault's plugin data (`data.json`) and is never logged.
- It leaves your device only in requests to Anthropic, or to the gateway you configured.
- The API-key and token fields render as password inputs, so the settings tab is safe to screen-share.
- If you sync your vault, `data.json` syncs with it.
- The [MCP bridge](claude-code-bridge.md) has a separate token with its own environment-variable escape hatch for exactly that reason.

See [faq.md](faq.md) for what else does and doesn't leave your machine.
