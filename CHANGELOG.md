# Changelog

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
