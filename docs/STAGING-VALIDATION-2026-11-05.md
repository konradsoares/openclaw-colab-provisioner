# Staging integration validation — 2026-11-05

## Scope and isolation

- Host: MacBook Ubuntu, OpenClaw 2026.10.9.
- OpenClaw profile: `ai-staging`, state directory `~/.openclaw-ai-staging`, loopback port 19041.
- Colab gateway staging port 18081; distinct Autopilot state from production port 18080.
- Telegram disabled; staging tool policy restricted to `read`.
- No production configuration, sessions, gateway services or repositories modified.
- GPU created solely for staging testing and explicitly deleted after tests. Final Colab runtime count: 0.

## Integration failures discovered and fixes

1. **Context overflow**: OpenClaw's initial compiled context exceeded 4,096 tokens. Staging provider model context and Ollama `COLAB_NUM_CTX` were aligned to 32,768, with validation and regression test.
2. **Streaming API mismatch**: OpenClaw requested `stream:true`, previously rejected. Gateway now emits OpenAI-compatible SSE chunks for completed Ollama responses, including tool calls.
3. **Structured text messages**: OpenClaw sends content parts, not only plain strings. Gateway now accepts text-only parts, flattening them for Ollama and rejecting non-text content.

## Real tests (not mocks)

| Test | Result | Time |
|---|---|---:|
| First Colab inference, including creation/bootstrap | `STAGING_COLAB_OK`, exit 0 | 221.1 s |
| Follow-up to same Colab session | Recalled `STAGING_COLAB_OK`, same runtime | 9.6 s |
| Read tool via OpenClaw on Colab | Read isolated fixture and returned expected marker | 23.0 s |
| Cross-model turn 1: Colab | Replied `ACK` to fictitious code | 13.6 s |
| Cross-model turn 2: local PAIR | Recalled fictitious code correctly | 15.9 s |
| Cross-model turn 3: Colab | Recalled fictitious code correctly | 9.0 s |

The OpenClaw session trajectory explicitly records a `tool.call read` followed by `tool.result read ok`, proving actual tool execution. Cross-model test used the **same OpenClaw session ID** with per-turn `--model` overrides.

One runtime ID was reused across Colab turns. Model and session remained healthy. The T4 runtime was released by the owned-runtime Autopilot; a subsequent API list returned zero runtimes.

## Automated tests

- Colab Provisioner: **37/37 passing**, `npm run check` passing.
- Smart Router (separate staging worktree): **23/23 passing** from previous validation.

## Limitations and release gates

- SSE is a buffered compatibility stream emitted **after** model completion, not true token-by-token streaming.
- Staging validation used only one tool (`read`); other tools and multiple concurrent tool calls remain unverified live.
- Cross-model memory passed for a short conversation, but lengthy histories, restarts, fallback, and truncated contexts need further tests.
- A robust shared-session model-selection path remains to be integrated into the Smart Router. Its existing direct HTTP Colab path does not carry full OpenClaw history.
- Colab provider can terminate runtimes independently of our configured 30-minute idle timeout.
- No production deployment, branch merge, or new release was made.

## Reproducible staging setup

The isolated profile used environment substitution for `COLAB_GATEWAY_API_KEY`. Secrets were not copied into the Git repository. Before real tests, check the Google Colab runtime list and eligibility, ensure only staging-specific state paths and ports are used, and obtain explicit authorization for consuming GPU quota. After testing, stop staging processes, release only the runtime recorded as owned in the staging Autopilot state, and confirm the runtime list is empty.
