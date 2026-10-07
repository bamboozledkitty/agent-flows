# Agent Flows

Build **flows** of Claude agents and logic cards on a canvas inside Claude Code:
a writer and a reviewer that loop until the review passes, a pipeline that hands
work down a chain, a triage team that routes each request to the right agent.
Each agent is a real Claude chat you can open and talk to; logic cards decide,
in plain English or by text checks, where each message goes next.

```
╭──────────────────────╮    ╭────────────────╮    ╭──────────────────────╮
│ ▶ Start              │    │ Lister       ⧉ │    │ ◇ Any United?        │
│ "List five countries"│─◆─▶│ ● Done         │─◆─▶│ has "United"         │
╰──────────────────────╯    ╰────────────────╯    │              Yes ●   │──╮
                                                  │               No ●   │──┼─╮
                                                  ╰──────────────────────╯  │ │
                           ╭────────────────╮                ╭──────────────▼─┴╮
                           │ ■ Done         │◀───────────────│ Filter        ⧉ │
                           │ ✓ France…      │                ╰─────────────────╯
                           ╰────────────────╯
```

## Install

You need [Claude Code](https://claude.com/claude-code) and any Claude account it
signs in with. From a terminal:

```
claude plugin marketplace add bamboozledkitty/agent-flows
claude plugin install agent-flows@agent-flows --scope user
```

The **user** scope gives every session the plugin. Then type `/flow` in any project.

To work on it from a clone instead:

```
git clone https://github.com/bamboozledkitty/agent-flows.git ~/agent-flows
claude plugin marketplace add ~/agent-flows
claude plugin install agent-flows@agent-flows --scope user
```

A folder marketplace is read from the folder itself, so edits take effect after
`/reload-plugins`.

## Use

- **`/flow`** opens the flows of the folder you're in.
- **Flows list (left):** `+ New flow`, then click a flow to open it. The open
  flow lists its cards, with `+ Add card` and `+ Add running chat` (bring in a
  Claude chat that's already open, history kept).
- **Canvas (middle):** drag cards, drag empty space to pan, double-click an
  agent to chat with it in a new tab. Cards take input on the left (**○**,
  **◉** once linked) and give output on the right (**●**). To link, **drag from
  a ● output onto another card**, or **drag from a ○ input back onto the card it
  should hear from** (or click a ●, or **→ Link** in its panel, then the target).
  Outputs only link to inputs: a wrong drop shows ⚠ and why. Drag a link's
  **▶ arrowhead** onto another card to re-wire it.
  Click a link's `◆` to edit or delete it.
- **Details (right):** the selected card's settings, or the link's max passes.
  With nothing selected: the flow's name, **▶ Run flow**, **■ Stop all**, and
  Delete flow.
- **Add a running chat:** browse folders from this project's; an orange ● marks
  folders with running chats in them or below. Type to search, click the folder
  to type or paste a path, and scroll with ▲ ▼ or the arrow keys.
- **Zoom:** `[ − ] 100% [ + ]` at the canvas's bottom left (or `-` / `+`, `0` for
  100%) zooms out to 75% and 50%: cards shrink to their name and status, and
  still drag, select and link.
- **Keys:** `n` add card · `a` add running chat · `c` link · `r` run ·
  `o` open chat · `x` delete · `Esc` close a menu.

## Cards

| Card | What it does | Outputs |
| --- | --- | --- |
| ● **Agent** | A Claude chat | Out |
| ▶ **Start** | Holds the command a run begins with. **Run flow** shows it to edit, then sends it | Out |
| ◇ **If / Else** | Checks the message: Claude judges a plain-English statement, or it contains / doesn't contain text, or matches a pattern | Yes, No |
| ⑂ **Switch** | Claude picks one of the named branches (e.g. bug, feature, question) | one per branch, Other |
| ⧓ **And (all)** | Waits until every card linking in has replied in this run, then passes their answers on together | Out |
| ⧗ **Or (first)** | Passes on the first reply in a run; later ones are dropped | Out |
| ✎ **Prompt** | Rewrites the message before the next card: `{{message}}`, `{{from}}` | Out |
| ↻ **Loop until** | Done when its condition holds or after N tries; otherwise Again | Done, Again |
| ◈ **Model** | Sets the model (Opus, Sonnet or Haiku) and effort of the agents it links into. Links into an agent's lower (model) dot; carries no messages | Out |
| ■ **End** | Shows the final answer, saves it to a file if set, and says the run finished | — |
| ✐ **Note** | A note for your team | — |

Agents have two inputs: the top dot takes messages, the lower dot a Model card.
With none linked, an agent runs on your default model. The model applies to
background runs and to chats opened in a new tab; a chat already open keeps the
model it started with. New agents are named `<flow name>-agent<N>`, numbered
across the project, so chat names never clash.

### More models

The Model card lists Opus, Sonnet and Haiku, which any Claude account runs. To
list others, a pinned version or the ids your LLM gateway serves, name them in
the plugin's **Extra models** option (under the plugin in `/config`), separated
by commas or spaces:

```
claude-opus-5-5, anthropic/claude-sonnet-5-5
```

The plugin never looks models up itself: it makes no network requests.

Cards warn on themselves when they're wired wrong (`⚠ Nothing on No`,
`⚠ Needs 2+ inputs`). A condition Claude can't judge counts as **No** (Switch:
**Other**; Loop: a failed try), and the log line says so.

## Demo flow

`examples/country-name-loop.json` is a small flow to try: a Start card asks the
first agent to list every country in a markdown file; an If card checks the file
was made; on Yes a Prompt card hands the list to a second agent, which keeps the
countries with "United" in their names; on No another Prompt says nothing came
in. A Model card runs the agents on Sonnet at medium effort.

To try it, copy it into a project's flows folder, then run `/flow`:

```sh
mkdir -p .claude/flows && cp ~/agent-flows/examples/country-name-loop.json .claude/flows/
```

Its agents start as fresh chats on the first run.

## Hand-offs

Linked chats talk to each other. When an agent's turn ends, however it started
(you typed in its chat, a linked agent messaged it, or a run), its reply goes
through the cards after it and into the next agents' chats, which answer in
turn. It works with the canvas closed.

- Each hand-off arrives as `[Agent Flows · run <id> · hand-off N]`. A link
  stops passing messages once N reaches its **max passes**, so loops always end.
  A chat also stops after 20 hand-offs between two of your own messages.
- An agent answers `[no reply]` when a hand-off needs no response, and nothing
  is passed on.
- Typing in an agent's chat starts a new run from that chat.

Agents know who they're linked to (through any logic cards between them) and may
also message them with `SendMessage`; messages to agents they aren't linked to
are refused.

## Where things are saved

- **Flows:** `<project>/.claude/flows/<flow>.json`, one file per flow. The
  folder holds a `.gitignore` of its own, since flows point at chats on this
  machine only.
- **Runs:** `<project>/.claude/flows/.runs/`, what And, Or, Loop and End remember
  per run. Cleared after 7 days, and with the flow when it's deleted.
- **Agent index:** `~/.claude/agent-flows/agents.json` maps each agent's chat to
  its flow file, so an agent finds its flow from any folder.
- **Chats:** where Claude Code keeps every chat, `~/.claude/projects/`.

An unreadable flow file is listed as *Can't read* and never overwritten.

## Runs and windows

Background runs belong to the Claude window that started them: closing the pane
keeps them going, quitting that window ends them. Agents open in their own tabs
carry on regardless. Two windows on the same project stay in sync every couple
of seconds; if both edit one flow at the same moment, the last save wins.

## Develop

```
claude plugin validate .
claude plugin test .
```

Tests live in `tests/`: storage, each card's routing, And / Or races, hand-offs
between chats, and canvas tests that build flows. Designs are in `docs/`.

## Versions

Semantic versions in `.claude-plugin/plugin.json`, tagged `vX.Y.Z`; changes in
[CHANGELOG.md](CHANGELOG.md).

## Security

Agents in a flow run as you, with the permission mode set on each card. Only run
flows you wrote or have read.

### What it runs, reads and sends

Everything stays on your machine, except what Claude Code itself sends to Claude.
The plugin makes no network requests, reads no credentials and no settings, and
has no telemetry.

**Programs it starts**

- `claude -p`, for an agent's background run, with the card's permission mode
  (default, accept edits or plan; never one that skips permissions) and, when a
  Model card links in, `--model` and `--effort`.
- A new terminal tab running `claude`, when you open an agent's chat: through
  `cmux` (the path in `CMUX_BUNDLED_CLI_PATH`), `open -na Ghostty`, or
  `osascript` with one of the two short scripts in `scripts/`, which tell iTerm
  or Terminal to run that one command. If none fits,
  the command is copied for you to paste.
- `mkdir`, `mv -f` and `rm -f` on its own files; `tail` and `find` on Claude
  Code's chat transcripts; `ps` to see which chats are running; and
  `find … -exec rm -rf` only on its own run folders in `.claude/flows/.runs/`.

**Files**

- Writes flow files and run memory under `<project>/.claude/flows/`, the agent
  index at `~/.claude/agent-flows/agents.json`, and an End card's *save to* file,
  only inside the project. It writes no settings, start-up or build files.
- Reads Claude Code's chat transcripts and running-chat list under `~/.claude/`,
  to show each agent's status and offer running chats.

**Hooks**

- `prompt.submit` and `session.receive`: for a chat that is an agent in a flow,
  read the hand-off tag on the incoming message (run id and count) and add a
  short note saying which agents it is linked to. Other chats pass through
  untouched.
- `turn.complete`: for an agent's chat, hand its reply to the next cards.
- `session.send`: refuse an agent's `SendMessage` to an agent it isn't linked to.
- `ui.close`, `ui.message`, `ui.render`, `command.run` for `/flow`: the canvas.

It hooks no tool calls, permission prompts, network or process events.

**What it sends between chats**

A hand-off is the sending agent's reply, wrapped in the link's template and a
`[Agent Flows · run <id> · hand-off N]` tag, delivered to the next agent's chat
on this machine. If, Switch and Loop cards set to plain English send that same
message to Claude, through Claude Code, for a one-word answer. Nothing else
leaves a chat.

**Tests** (`tests/`) run only under `claude plugin test`: they stand in for the
engine, so they answer file, process and command events themselves. They are
not loaded when the plugin runs.

## License

MIT. See [LICENSE](LICENSE).
