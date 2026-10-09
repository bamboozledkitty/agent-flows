# Model card and agent names — design

Date: 2026-10-07 · Status: implemented

## Goal

Let a flow choose which model, and how much effort, each agent runs with: Opus,
Sonnet or Haiku, or an id the person names in the plugin's options. And
give new agents tidy,
sequential names, so Claude never appends random words to them.

## Model card

A new card, `◈ Model` (kind `model`), in the Add a card menu after Prompt.

- **Settings** (`card.model`, `card.effort`): a model from the list below and
  an effort level: Low, Medium, High, Extra high or Max (`low` … `max`, the
  values `claude --effort` takes). Effort may be left unset: the model's own default.
- **On the canvas**: the summary reads `sonnet-5-5 · high` (the id without its
  `claude-` prefix), or `Pick a model`.
- **One output** (`out`), no input. It links only into an agent's model input.
  One Model card may feed many agents.
- **Warnings**: `Pick a model` when none is set; `Link it to an agent` when it
  has no link.

Model cards never carry messages: nothing links into one, so a run never reaches
it, and the hand-off code (`register.tsx` edge walks, And/Or inputs) is untouched.

## Agent card: two inputs

- **Message** (top dot, row 2): unchanged.
- **Model** (new dot, row 3): takes only a link from a Model card.

A link is a model link exactly when it leaves a Model card; no new field on
`FlowEdge`. The canvas draws a model link's
arrowhead at the agent's row 3, in its own colour (blue), and it is re-wired by
dragging, like any link.

Drop rules (canvas `judgeDrop`, and `connect` / `relink` in `register.tsx`, which
re-check so a bad file edit can't wire it):

| From | Onto | Result |
| --- | --- | --- |
| Model card | agent's model dot or the agent card | link made |
| Model card | anything else | `Only agents take a model` |
| any other card | an agent's model dot | `Only a Model card links here` |
| Model card | an agent that already has one | the old model link is replaced |

An agent with a model link shows the model under its name (`◈ sonnet-5-5 · high`);
its side panel adds a `MODEL` section naming the card, or `Your default model`.

## Where the model applies

The model and effort resolved from the agent's model link are added as
`--model <id>` and `--effort <level>` to:

- every background run (`runNode`, `claude -p …`), and
- opening the chat in a new tab (`openSession`).

The link is read at launch, so re-linking applies from the next run. A chat
already open in a tab switches too: Agent Flows in that chat names the card's
model and effort on each model request (`turn.step`), so it applies from the
chat's next message. `/model` was ruled out: it also saves the choice as the
person's default for new chats. A request takes no alias, so `opus`, `sonnet` and
`haiku` become that family's first id in the Extra models option; with none
there the request is left as it was. Its side panel says
`Open in a tab: used from its next message`.

## The model list

`opus`, `sonnet` and `haiku` (the CLI's own aliases), then the ids in the
plugin's `extraModels` option (`userConfig`, read by `register`), split on commas
and spaces. An entry that is not a model id (it could read as a flag, or holds a
space or `;`) is left out and named in the panel's note. Nothing is fetched: the
plugin makes no network request and reads no key.

## Agent names

New agents are named `<flow slug>-agent<N>`, e.g. `country-name-loop-agent1`.

- `<flow slug>`: `slug(flow.name)` from `store.ts`.
- `N`: one more than the highest `-agent<N>` among every agent's name in every
  flow in the project, so numbers never repeat across flows, and deleting an
  agent never hands its number to the next one.
- Existing agents keep their names. Renaming a flow doesn't rename its agents.
- The engine adds `-word-word` only when a session name is taken; these names
  aren't, so it doesn't. `adopt` still strips that suffix from adopted chats.

`newCard(kind, id, x, y, count)` takes the name instead of `count` for agents;
`register.tsx` computes it with a new pure `nextAgentName(flows, flowName)` in
`cards.ts`.

## Testing

- `cards.test.ts`: Model card ports, summary and warnings; `nextAgentName` (empty
  project, gaps, numbers in other flows, other names ignored); the model list
  from the option, with entries that are not model ids left out.
- `canvas-cards.test.ts`: drag Model → agent's model dot links; Model → If refuses
  with its reason; Prompt → model dot refuses; a second Model link replaces the first.
- `flow.test.ts`: a run of a linked agent spawns with `--model` and `--effort`; an
  unlinked one with neither; opening in a tab passes both.
- Live check: one real run with a Model card set to Haiku; the agent's transcript
  shows that model.
