---
title: How it works
type: concept
summary: The pieces Woopcode is built from and how a prompt travels through them.
prerequisites:
  - /docs/introduction/how-a-turn-works
related:
  - /docs/architecture/adding-a-tool
  - /docs/architecture/running-from-source
since: 0.6.0
---

# How it works

This page is for people changing Woopcode. If you only want to use it,
[How a turn works](/docs/introduction/how-a-turn-works) is the version you
want.

## The layers

```text
cli.ts              argument parsing, subcommands
  commands/         the agent controller and slash commands
    tui/            the React Ink interface
  config/           the agent loop, provider client, context, persistence
    runtime/        approval classification and policy
      tools/        the tool registry
```

Two things are worth noticing about that shape. **The agent loop lives in
`config/runtime.ts`, not in `commands/`** — it is deliberately free of any
knowledge of the interface, which is what lets the same loop drive both the TUI
and the headless `--prompt` path. And **approval is split in two**:
`runtime/approval/classifier.ts` decides how risky a command is,
`runtime/approval/policy.ts` decides whether that risk needs asking. Neither
knows about shell syntax and the UI respectively, so adding a mode is one entry
in a table.

## A prompt, end to end

1. **`cli.ts`** parses arguments and hands off to `runAgent`. A non-empty
   `--prompt` takes the headless path; otherwise the TUI renders.
2. **`AgentController`** owns the session — the provider client, the selected
   model, cancellation, and the pending user message.
3. **`buildRepositoryContext`** in `config/config.ts` assembles package
   metadata, README, and top-level structure, each capped, the whole capped
   again at 8,000 characters.
4. **`agentLoop`** in `config/runtime.ts` runs the cycle: stream from the
   provider, collect tool calls, execute them, feed results back. Up to 20
   iterations.
5. **Tools** resolve through `toolRegistery` in `tools/index.ts`. Writing tools
   raise an approval request; shell tools are classified and checked against
   the policy.
6. **Callbacks** (`AgentCallbacks`) carry text, tool starts, tool finishes, and
   errors back out. The TUI renders them; the headless path prints them.

## Design decisions worth knowing

**Unrecognised means risky.** A shell command the classifier does not recognise
is treated as destructive, not safe. Failing closed is the only defensible
default for something with write access to a repository.

**Tool errors go back to the agent.** A failed tool call returns its error as a
result rather than ending the turn, so the model can correct a bad path and
retry. Only the iteration budget ends a turn.

**Persistence drops tool traffic.** Only user and assistant messages are saved.
Half of a call/result pair would make restored history invalid for the
provider.

**Config failures never block startup.** A corrupt `providers.json` is moved
aside and defaults are recreated. A malformed approval mode falls back to the
default rather than to permissive.

**The workspace boundary is resolved, not string-matched.** Paths are resolved
through symlinks before the containment check, so a link cannot be used to
escape.

## Provider clients

`config/client.ts` builds a client for the configured provider. The interface is
`ProviderClient`, whose `stream()` yields `StreamEvent`s — `text`, `tool_call`,
`done`. Adding a provider means implementing that interface and enabling the
entry in `config/providerRegistry.ts`; the loop above does not change.

Google, OpenAI and Anthropic are all enabled. `enabled: false` remains the way
to list a provider the interface should show as planned rather than pretend
works; nothing is in that state today.

The clients differ in more than their request shape. Both Anthropic and OpenAI
have to send the reasoning that preceded a tool call back with that call's
result, and both fail quietly if it is missing — the request is accepted and the
model simply reasons from less than it had, with nothing in the response to show
for it. So `config/anthropicClient.ts` and `config/openaiClient.ts` each keep
those items for the length of a turn and replay them.

The mechanics differ. Anthropic pauses mid-response to await the tool and
resumes the same response, so a modified thinking block is rejected outright.
OpenAI is stateless here by choice — `store: false`, because the conversation is
rebuilt from `Message[]` every turn — so its reasoning items are replayed in the
request input. Its one trap is where the item is read from: `encrypted_content`
is populated on `response.output_item.done` and not on the `.added` that
announces the same item, so a client that captures too early replays an empty
husk.

## Tests

```bash
bun test
```

Unit, integration, and property suites across the runtime and the tools.
`bun run test` runs them together with `tsc --noEmit`, which is what CI does.

## Next

- [Running from source](/docs/architecture/running-from-source)
- [Adding a tool](/docs/architecture/adding-a-tool)
