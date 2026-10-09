# Changelog

## 0.2.0 — 2026-10-09

### Added
- **See what an agent is doing without leaving the canvas.** Agent cards show
  status and model, with **See response ›** (**Watch live ›** while it works).
  A selected agent opens an activity drawer under its card: the prompt it's on,
  its thinking, and its newest lines. **View chat** (or `v`) opens the agent's
  conversation over the canvas, read-only, following along as it works.
- **Agent instructions:** an agent's Instructions are sent ahead of every
  message it gets in a flow. A line that is just `@path` (e.g. `@CLAUDE.md`)
  adds that file. Only files inside the project or the agent's own folder, or
  `.md` files in `~/.claude`, are read; others are left out with a note in the
  log.
- **A Model card switches a chat that's already open,** from its next message,
  without changing your default model. For Opus, Sonnet or Haiku this needs a
  full id for that family in the *Extra models* option.
- **A cursor in every text box:** ← → Home End and clicks move it, ↑ ↓ move
  between lines, and Cmd+V or Ctrl+V pastes at it.
- **A card's `in` socket names its source,** faintly: `in ← Lister`.
- **Side panels scroll** with ▲ ▼ (or PgUp / PgDn) when taller than the screen.

### Changed
- **Cards come in bands:** title, sockets, body, and for an agent its status.
  Agent cards are 10 rows and logic cards 7, so flows built on the old sizes
  may need cards dragged apart.
- **Prompt cards take plain sentences.** With no `{{message}}`, what came in
  goes under your text; an empty Prompt passes the message on.
- **▶ Test** on an agent sends it a one-off message; the Run prompt field is gone.
- **Live preview is faster** for chats open in a tab, and shows thinking.
- A running card's dot blinks; ⧉ now only means "open in a tab".

### Fixed
- Typing in a text box is kept when you click away.
- A save and a run sent in one click no longer lose the save.
- Linking a Model or logic card no longer messages the agent about it.
- In cmux, opening an agent that's already open switches to its tab.

## 0.1.0 — 2026-10-07

First release.

- **Flows:** a project holds many flows, each a team or loop of linked Claude
  agents and logic cards, saved one file per flow in `<project>/.claude/flows/`.
  Several flows can run at once. `/flow` opens them.
- **Cards:** ● Agent, ▶ Start, ◇ If / Else, ⑂ Switch, ⧓ And (all), ⧗ Or
  (first), ✎ Prompt, ↻ Loop until, ◈ Model, ■ End and ✐ Note. If, Switch and
  Loop ask Claude about the message in plain English, or check text.
- **Canvas:** drag cards, pan, zoom to 75% and 50%; drag from a ● output or a ○
  input to link, drag an arrowhead to re-wire; wrong drops are refused with the
  reason. Cards warn on themselves when wired wrong.
- **Hand-offs:** when an agent's turn ends, its reply goes through the cards
  after it into the next agents' chats, canvas open or not. Each hand-off
  carries a run id and count; links stop at their max passes, a chat after 20
  hand-offs between two of your messages, a run after 50 in all.
- **Runs:** And, Or, Loop and End keep their memory per run in
  `.claude/flows/.runs/`, with locks so two replies landing together can't both
  get through. Run folders older than 7 days are cleared.
- **Running chats:** bring an open Claude chat into a flow, history kept, from a
  browser of the folders chats are running in.
- **Model card:** sets the model and effort of the agents it links into: Opus,
  Sonnet and Haiku, plus any ids you name in the *Extra models* option.
- **Safety:** the plugin makes no network requests and reads no credentials or
  settings; flow files with ids that could leave the run folder, a relative `cwd` or a
  model that reads as a flag are refused as unreadable; End saves only inside
  the project.
