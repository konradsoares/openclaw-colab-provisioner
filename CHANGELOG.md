# Changelog

## Unreleased

### Added
- Adapt OpenAI function tools and tool-result history to Ollama messages. Return OpenAI tool_calls without executing tools on the gateway.
- Add a simulated two-turn tool-call roundtrip and validation tests.


### Fixed
- Authenticated, valid chat activity is now the only input that resets the gateway idle clock; health probes and unauthorized traffic cannot indefinitely retain a GPU.

### Tests
- Added deterministic fake-clock tests for the 30-minute idle boundary, repeated activity, and in-flight request protection.

## v1.3.0-beta.3
- Existing tagged release; see git tag and README for previous release history. No historical tags were changed.
