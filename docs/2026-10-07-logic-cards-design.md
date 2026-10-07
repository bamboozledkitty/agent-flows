# Logic cards — design

Date: 2026-10-07 · Status: implemented

## Goal

Let a flow be steered by cards, not only agents: a **Start** card that holds the
command a run begins with, and logic cards between agents that decide, in plain
English or by text checks, where a message goes next. Inspired by the logic
nodes of the Tokens Studio graph engine (If, Compare, And, Or, Not, Switch),
kept small.

## Cards

| Card | Does | Outputs |
| --- | --- | --- |
| Agent | A Claude chat (as before) | out |
| ▶ Start | Holds the command. Run flow pre-fills it for editing, then sends it | out |
| ◇ If | Checks a condition on the message: Claude judges plain English, or contains / doesn't contain / pattern | yes, no |
| ⑂ Switch | Picks one named branch, judged by Claude | one per branch, other |
| ⧓ And (all) | Waits until every input has replied in this run, then passes their answers on together | out |
| ⧗ Or (first) | Passes on the first reply in this run; later ones are dropped | out |
| ✎ Prompt | Rewrites the message: `{{message}}`, `{{from}}` | out |
| ↻ Loop until | Each pass: condition holds or N tries reached → done; else again | done, again |
| ■ End | Shows the final answer, optionally saves it to a file, marks the run finished | — |
| Note | Sticky note; no links | — |

Links are plain arrows from a card's output to a card. A link keeps **max
passes** (default 3): it stops carrying a run's messages once the hand-off count
reaches it.

## Data model (file version 2)

Agents and cards share one list (`agents` in the file, `nodes` in memory):
`kind` (default `agent`) and `card` settings per kind — `cond`/`value` (If,
Loop), `branches` (Switch), `template` (Prompt), `maxTries` (Loop), `saveTo`
(End), `text` (Note); Start's command is its `prompt`. A link has `port`
(default `out`).

**Reading a version-1 file** (rules on links, before logic cards): for each agent, every link with a rule other than
`always` / `else` becomes an If card placed on that link (yes → its old target,
same condition and max passes). With one rule link, the agent's `else` links
hang off that If's no; with several, the Ifs are chained by their no outputs and
the `else` links hang off the last one.

## Running

Every message carries `[Agent Flows · run <id> · hand-off <n>]`. Run flow makes a
new run id; typing in an agent's chat starts a new run from that agent. A message
entering an agent counts one hand-off; logic cards don't.

Whichever process just finished an agent's turn (the agent's own chat, or the
window whose background run it was) walks the cards after it: If, Switch, Prompt
and Loop are worked out there; agents are delivered to as before (into an open
chat, else a background run).

Shared run memory lives in `<project>/.claude/flows/.runs/<flowId>-<run>/`:
- **And:** one file per input as it arrives; when all inputs are in, a lock
  (`mkdir`, atomic) lets exactly one process pass the combined answers on,
  each headed by its agent's name.
- **Or:** the same lock; the first to take it passes its message on.
- **Loop:** one lock folder per try, so tries count across processes.
- **End:** the result as `end-<card>.json`, and the `saveTo` file (relative to
  the project) when set. The canvas shows the latest result on the End card and
  raises "Run finished".

Run folders older than 7 days are removed when `/flow` opens, and a flow's run
folders when the flow is deleted.

## Failure handling

- A condition Claude can't judge (time-out, unclear answer) counts as no / other
  / a failed try, and the canvas log says why.
- And shows "waiting k of n" and a **Pass on now** button that passes on what has
  arrived in the latest run.
- Warnings on cards, not failures mid-run: Start with no link out, If missing a
  yes or no link, End with links out, And with fewer than two inputs.
- Run flow with no Start card adds one, selects it and says what to do.

## UI

- **+ Add card** (Flows list, and `n` on the canvas) lists Agent and the nine cards.
- Cards with several outputs show each as a labelled dot on their right edge;
  click a dot, then the target, to link from that output. The details panel also
  lists each output with **→ Link to…**.
- Each card's settings are edited in the details panel.

## Testing

Unit: each card's routing, the upgrade from version 1, the hop/run tag. A
two-process race on And and Or over a shared in-memory run folder. Canvas
end-to-end: Start → Agent → If → two agents → And → End. One live run in real
chats.
