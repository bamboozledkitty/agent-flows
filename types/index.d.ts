export type PermMode = 'default' | 'acceptEdits' | 'plan'

/** What a card on the canvas is: an agent (a Claude chat) or one of the logic cards. */
export type CardKind = 'agent' | 'start' | 'if' | 'switch' | 'all' | 'first' | 'prompt' | 'loop' | 'end' | 'note' | 'model'

/** How hard an agent thinks: the levels `claude --effort` takes. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A check a card makes on a message: Claude judges it, or a text test. */
export type CheckKind = 'judge' | 'contains' | 'not-contains' | 'regex'

/** A logic card's settings; each kind reads its own. */
export type CardConfig = {
  /** If, Loop: how the condition is checked, and what it checks. */
  check?: CheckKind
  value?: string
  /** Switch: the branch names, each an output. */
  branches?: string[]
  /** Prompt: the rewritten message; `{{message}}` and `{{from}}` filled in. */
  template?: string
  /** Loop: tries before it gives up and goes on (done). */
  maxTries?: number
  /** End: a file to save the final answer to, relative to the project. */
  saveTo?: string
  /** Note: its text. */
  text?: string
  /** Model: the model id the agents it links into run with, and their effort (unset: the model's default). */
  model?: string
  effort?: Effort
}

export type FlowNode = {
  id: string
  name: string
  x: number
  y: number
  /** Absent: an agent. */
  kind?: CardKind
  card?: CardConfig
  /** Agent: what a manual Run sends it. Start: the command a run begins with. */
  prompt: string
  mode: PermMode
  /** The real Claude session behind the node; set on first run or open. */
  sessionId?: string
  /** The folder the chat runs in, when it joined from another folder; else the project's. */
  cwd?: string
}

/** `else` fires only when no other outgoing edge of the node matched. */
export type Condition = 'always' | 'contains' | 'not-contains' | 'regex' | 'judge' | 'else'

export type FlowEdge = {
  id: string
  from: string
  to: string
  cond: Condition
  /** The text, pattern, or plain-English test the condition checks. */
  value: string
  /** Loop guard: how many times this edge may fire per flow run. */
  maxPasses: number
  /** What the target receives; `{{output}}` and `{{from}}` are filled in. */
  template: string
  /** The output of `from` the link leaves: `out` (absent), `yes`, `no`, a branch name, `other`, `done`, `again`. */
  port?: string
}

export type Graph = { nodes: FlowNode[]; edges: FlowEdge[] }

/**
 * A flow: one team or loop of linked agents. In the UI a node is an Agent and an
 * edge a Link. Saved as `<project>/.claude/flows/<file>`.
 */
export type FlowDoc = Graph & {
  id: string
  name: string
  /** Absolute path of the flow's file. */
  file: string
}

/** One row of the Flows list. */
export type FlowSummary = { id: string; name: string; status: RunStatus; count: number; cards: number }

export type Selection =
  | { kind: 'none' }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }

export type RunStatus = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'stopped'

export type NodeRun = {
  status: RunStatus
  /** Last few lines of activity, newest last. */
  preview: string[]
  lastOutput: string
}

/** What the canvas surface module is handed. */
export type CanvasNode = {
  id: string
  name: string
  x: number
  y: number
  kind: CardKind
  card: CardConfig
  /** Outputs, in the order drawn down the card's right edge. */
  ports: string[]
  /** Card height in rows. */
  ht: number
  /** A logic card's one-line summary of its settings. */
  summary: string
  /** Something wired wrong, said on the card. */
  warning?: string
  /** And: inputs in, of all, in the latest run. */
  waiting?: { got: number; of: number }
  /** End: the latest run's final answer. */
  result?: { text: string; at: number }
  status: RunStatus
  preview: string[]
  prompt: string
  mode: PermMode
  /** Running right now in some terminal (the session registry lists it). */
  isOpen: boolean
  hasSession: boolean
  /** Agent: the model its Model card sets, e.g. `sonnet-5-5 · high`; absent with none linked. */
  model?: string
}

/** A Claude session running on this machine that the canvas could adopt. */
export type AvailableSession = { sessionId: string; name: string; cwd: string; startedAt: number }

/**
 * The running-chat browser at one folder: its subfolders (each with the chats running
 * in it or below), and every chat that could join running in it or below.
 */
export type PickerView = {
  dir: string
  home: string
  folders: { name: string; path: string; chats: number }[]
  chats: AvailableSession[]
  /** Why the last folder typed wasn't opened. */
  note?: string
}

export type CanvasEdge = {
  id: string
  from: string
  to: string
  port: string
  label: string
  cond: Condition
  value: string
  maxPasses: number
  fromName: string
  toName: string
  /** From a Model card: lands on the agent's model dot and carries no messages. */
  isModel: boolean
}
export type CanvasProps = {
  /** The project folder's name, for the list's title. */
  project: string
  flows: FlowSummary[]
  /** The flow on the canvas; null when the project has none. */
  openFlowId: string | null
  /** Flow files that could not be read; shown, never written. */
  broken: string[]
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  selected: Selection
  connectFrom: string | null
  /** The output a link being made leaves from. */
  connectPort: string
  /** The running-chat browser while it is open; null when closed. */
  picker: PickerView | null
  /** The models a Model card offers; null until first loaded. */
  models: ModelList | null
}

/** The Model card's choices; `note` names entries of the "Extra models" option that were left out. */
export type ModelList = { ids: string[]; note?: string; loading?: boolean }

/** A card's settings from its panel; an empty effort clears it. */
export type CardPatch = Partial<Omit<CardConfig, 'effort'>> & { prompt?: string; effort?: Effort | '' }

/** What the canvas posts back to the hooks module. */
export type CanvasMessage =
  | { t: 'select'; sel: Selection }
  | { t: 'move'; id: string; x: number; y: number }
  | { t: 'open'; id: string }
  | { t: 'connect'; from: string; to: string; port?: string }
  | { t: 'relink'; id: string; to: string }
  | { t: 'connect-start'; id: string; port?: string }
  | { t: 'cancel' }
  | { t: 'new'; x: number; y: number; kind?: CardKind }
  | { t: 'delete' }
  | { t: 'run'; id: string }
  | { t: 'edge'; id: string; patch: { cond?: Condition; value?: string; maxPasses?: number } }
  | { t: 'node'; id: string; patch: { name?: string; prompt?: string; mode?: PermMode } }
  | { t: 'stop'; id: string }
  | { t: 'fresh'; id: string }
  | { t: 'picker'; open: boolean }
  /** Browse to a folder: one clicked, or a path typed or pasted. */
  | { t: 'picker-dir'; dir: string }
  | { t: 'adopt'; sessionId: string; name: string; cwd: string; x: number; y: number }
  | { t: 'flow-new' }
  | { t: 'flow-open'; id: string }
  | { t: 'flow-patch'; id: string; patch: { name?: string } }
  | { t: 'flow-run'; id: string; command?: string; startId?: string }
  | { t: 'card'; id: string; patch: CardPatch }
  | { t: 'all-flush'; id: string }
  | { t: 'flow-stop'; id: string }
  | { t: 'flow-delete'; id: string }
  | { t: 'models'; refresh?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'agent-flows': {
      flows: Record<string, FlowDoc>
      openFlow: string | null
      broken: string[]
      sel: Selection
      runs: Record<string, NodeRun>
      connectFrom: string | null
      connectPort: string
      log: string[]
      results: Record<string, { text: string; at: number }>
      waiting: Record<string, { got: number; of: number }>
      picker: PickerView | null
      liveIds: string[]
      models: ModelList | null
    }
  }
}
