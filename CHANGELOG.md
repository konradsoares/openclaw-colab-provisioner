# Changelog

## Unreleased

### Structured text compatibility
- Accept text-only OpenAI message content parts and flatten them for Ollama; reject non-text inputs.


### OpenClaw streaming compatibility
- Accept streamed OpenAI chat requests and serialize completed Ollama responses as SSE chunks, including tool calls and optional usage.
- Add SSE regression tests for text and tool calls.


### Session recovery
- Recreate an expired session within the same owned Colab runtime when the provider explicitly reports a missing session. Avoid GPU reprovisioning for this case.
- Add tests for safe recovery and unrelated upstream errors.


### Runtime health
- Check the Ollama model before reusing a previously ready runtime (five-minute probe cache); bootstrap again in the owned session when model health fails, without creating a new GPU.
- Add deterministic tests for healthy reuse and model recovery.


### Added
- Adapt OpenAI function tools and tool-result history to Ollama messages. Return OpenAI tool_calls without executing tools on the gateway.
- Add a simulated two-turn tool-call roundtrip and validation tests.


### Fixed
- Authenticated, valid chat activity is now the only input that resets the gateway idle clock; health probes and unauthorized traffic cannot indefinitely retain a GPU.

### Tests
- Added deterministic fake-clock tests for the 30-minute idle boundary, repeated activity, and in-flight request protection.

## v1.3.0-beta.3
- Existing tagged release; see git tag and README for previous release history. No historical tags were changed.
