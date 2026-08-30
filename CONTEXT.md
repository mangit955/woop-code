# Woopcode

A terminal-native coding agent: a streaming agent loop driving a React Ink
interface, and the same loop driving a headless single-prompt path. This file is
the glossary — what the words mean here. Mechanism lives in the code, and the
reasoning behind a hard-to-reverse choice lives in `docs/adr/`.

## Language

### A unit of work

**Turn**:
One stretch of work answering one user message, from the loop being entered to
it returning an answer. A turn survives being asked to continue at the iteration
ceiling; it is still the same turn.
_Avoid_: request, session, conversation

**Iteration**:
One provider response and the tool calls it carried. The unit both budgets and
every counter are measured in.
_Avoid_: loop, cycle, round

**Step**:
An iteration, when counted against what remains rather than what has happened.
The wall budget is converted into steps at the rate the turn has been running
at, so one warning can serve both budgets.

**Turn-initiating message**:
The message that started the turn — the last real conversation turn present when
the loop was entered. In a headless run it is the task statement; in the
interface it is what the user just typed. Pinned into the window for the life of
the turn, because the loop pushes messages of its own that would otherwise crowd
it out.
_Avoid_: the prompt, the first message, the task

**Window**:
The tail of the transcript actually sent to the provider, counted in
conversation turns rather than messages. Distinct from the transcript, which is
everything the turn has accumulated.

### Ending a turn

**Finish gate**:
A check that runs when the model responds without calling a tool, deciding
whether the turn may end or must go round once more. There are two, and both may
answer at once, in which case the turn receives a single message.

**Verification reminder**:
The finish gate that fires on unverified edits. Evidence the loop can see.

**Requirement gate**:
The finish gate that fires on an unattended turn stopping early with budget in
hand, asking it to prove each stated requirement with command output. Aimed at
what the loop cannot see: work that was checked thoroughly against the wrong
property.

**Unverified edits**:
A turn that changed the workspace and ran no shell command afterwards. Order
within an iteration is what decides it, so this is counted in tool executions
rather than iterations.

**Unattended**:
Nobody is reading the answer as it arrives, so a wrong one stands. True of the
headless path, false of the interface — where a person can correct a turn for
the cost of one sentence.
_Avoid_: headless, non-interactive, automated

**Wind-down warning**:
The message telling the model its turn is nearly over and to start nothing new.
Derived from a rate measured on the turn itself, so it can clear again when the
rate recovers.

**Budget**:
What bounds a turn. Two of them — iterations and wall-clock seconds — and a turn
stops on whichever binds first. Neither is a quota: the provider enforces that
itself.
