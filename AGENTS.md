## Subagents
When I ask you to start or delegate to a subagent, use the `worker` profile
and explicitly set its model to `openai-codex/gpt-6-luna`.
Do not rely on the worker profile's default model. When a thinking level is requested,
pass it as the per-dispatch `thinking` option; otherwise omit that option so the
agent profile's default thinking level is preserved.
