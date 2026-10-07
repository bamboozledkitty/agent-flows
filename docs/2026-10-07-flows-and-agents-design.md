# Flows and Agents — design

Date: 2026-10-07 · Status: implemented

## Goal

A per-project tool that holds many **flows**, each a team or loop of linked **agents** (Claude
chats), several of which can run at once.

## Terms

| Term | Meaning |
| --- | --- |
| **Flow** | A named group of linked agents: one team or loop |
| **Agent** | One Claude chat in a flow, shown as a card |
| **Link** | A one-way hand-off between two agents in the same flow |

User-facing text uses these terms everywhere; in code, agents and links keep the
internal names `FlowNode` and `FlowEdge`. The command is `/flow`.

## Decisions

1. Parent is a Flow; children are Agents.
2. Several flows can run at the same time.
3. Flows are saved in the project, in `<project>/.claude/flows/`, git-ignored.
4. The project is the folder `/flow` was typed in (`$.session.root()`), whatever
   folder the mod is installed in.
5. An agent belongs to exactly one flow; links never cross flows.

## UI

```
╭─ Flows · my-project ──╮ ╭──── canvas: "Release notes" ────╮ ╭─ Agent: Writer ─╮
│ [ + New flow ]        │ │  Writer ──[always]──▶ Reviewer   │ │ details …       │
│ ▾ Release notes  ◐ 2  │ │         ◀─[has "REVISE"]─        │ │                 │
│   ○ Writer   working  │ │                                  │ │                 │
│   ○ Reviewer done     │ │                                  │ │                 │
│ ▸ Bug triage     ● 3  │ │                                  │ │                 │
│ [ + Add agent ]       │ ╰──────────────────────────────────╯ ╰─────────────────╯
```

- **Left — Flows list.** Every flow in the project, with a combined status icon
  (running beats error beats done beats idle) and its agent count. The open flow
  is expanded to list its agents; clicking an agent selects and centres it.
  Clicking another flow switches the canvas to it. `+ New flow` at top;
  `+ Add agent` and `+ Add running chat` under the open flow.
- **Middle — Canvas.** The open flow only. Behaviour as today (drag, pan,
  double-click to open a chat, click a link label for its rule).
- **Right — Details.** The selected agent or link, as today. With nothing
  selected: the open flow's settings — Name, ▶ Run flow, ■ Stop all, Delete flow.
- Flows not on the canvas keep running; their status still updates in the list.

## Storage

```
<project>/.claude/flows/
  release-notes.json
  bug-triage.json
  .gitignore            # contains "*" so the folder ignores itself
```

- **One file per flow**: `{ version: 1, id, name, agents: [...], links: [...] }`,
  agents and links shaped as today's nodes and edges. File name is a slug of
  the name plus a short id when two names collide; renaming a flow does not
  rename its file (the id is the identity).
- Written whole on each change (write to `<file>.tmp`, then rename).
- **Lookup index** `~/.claude/agent-flows/agents.json`:
  `{ [chatSessionId]: { flowFile: <absolute path> } }`. Updated when an agent gets
  a chat id, is added from a running chat, or is deleted. Pointers only.
- **Chat history** stays in Claude's own `~/.claude/projects/` store.
- Project files are the single source of truth.

## How an agent finds its flow

On each prompt and each outgoing message, an agent chat resolves itself:

1. Look up its own chat id in `agents.json` → flow file.
2. Fallback: scan `<its root>/.claude/flows/*.json` for an agent with its id
   (repairs a missing index entry).
3. Not found → it is an ordinary chat: no context added, no messages gated.

The result is cached for the turn, keyed on the flow file's modified-time,
so ordinary chats pay one small file read per prompt.

## Running

- **▶ Run flow** sends each agent that has a start prompt and no incoming
  links its prompt. If no agent qualifies, it says so.
- **▶ Run** on one agent works as today.
- Hand-offs follow links within the flow. Loop limits (max passes) are counted
  per flow per run; ■ Stop all stops that flow's background runs and clears
  its queue.
- Runs belong to the Claude window where `/flow` was opened: closing the pane
  keeps them going; quitting that window ends background runs. Agents open in
  their own tabs are independent.
- The watcher (status from transcripts, running-chat list) starts on `/flow`,
  stops on pane close, and covers every flow in the project.

## Hand-offs

Each agent chat hands its own finished turns on (`turn.complete`), so linked chats
answer each other without the canvas. The reply goes to each matching link's
target: into its chat with `$.session.send` when that chat is open, else as a
background run (`claude -p`, `AGENT_FLOWS_CHILD=1`) whose spawner hands its
reply on. Every hand-off message carries `[Agent Flows · hand-off N]`; a chat
takes N from the latest message to reach it (read anywhere in the text, since
the engine wraps peer messages in an envelope), resets to 0 when its person
types, and a link fires only while N < its max passes. Backstops: 20 hand-offs
per chat between person messages, and `[no reply]` answers are not passed on.

## Multiple windows

Each window with `/flow` open re-reads the project's flow files every 2 s
(by modified-time) and redraws on change. Simultaneous edits to the same flow:
last write wins.

## Failure handling

- **Unreadable flow file:** listed as "⚠ Can't read <file>"; never written to.
- **Save fails:** toast "Couldn't save <flow>: <reason>"; edits stay in memory
  and the next change retries.
- **Index unwritable:** agents fall back to the folder scan; a toast says so once.
- **Flows folder can't be created** (read-only project): toast, canvas still
  usable in memory for the window's lifetime.

## Code layout

- `hooks/store.ts` — project flows folder: list, read, write, slug, index
  read/write. Pure functions over `$.fs`.
- `hooks/flow.ts` — conditions, templates, parsing (unchanged), `CARD`.
- `hooks/register.tsx` — state per open project: `flows` (by id), `openFlowId`,
  selection, runs; hooks and message handling.
- `hooks/canvas.tsx` — Flows list replaces the Sessions list; flow settings in
  the details panel; wording to the new terms.
- `types/index.d.ts` — `FlowDoc` (a flow) and `FlowSummary`; agents and links keep their internal names `FlowNode` / `FlowEdge`; state contract.

## Testing

- Unit (`store.ts`): write then read a flow; slug collisions; atomic write;
  unreadable file reported, not overwritten; index add/remove.
- Unit: agent self-lookup via index, via folder fallback, and ordinary chat.
- Canvas end-to-end: create two flows, switch, add an agent to each, link
  within one; a link to an agent in another flow is impossible from the UI;
  Run flow with no starting agent explains why.
- Fresh headless session in a temp project: `/flow` registers; flows folder
  and `.gitignore` are created on first save.

## Out of scope

Sharing flows through git, cross-flow links, and an agent in two flows.
