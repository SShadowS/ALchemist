# Protocol v2 sample fixtures

These are real outputs from the AL.Runner fork branch
`feat/alchemist-protocol-v1` (commit `605955b` as of 2026-04-29). They are
used by ALchemist's unit tests to validate the protocol-v2 consumer
without spawning a live runner process.

If you regenerate them, see
`U:/Git/AL.Runner-protocol-v2/AlRunner.Tests/ServerProtocolV2Tests.cs`
for the canonical wire-format assertions.

## Files

- `runtests-coverage-success.ndjson` — `runtests` against the
  `protocol-v2-line-directives` fixture with `coverage:true` +
  `captureValues:true`. Includes one passing test with no captures, one
  passing test with captured values, one failing test with stack frames,
  summary with protocolVersion: 2 and structured coverage.
