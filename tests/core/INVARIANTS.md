# Protocol Invariants

INV-01 | An agent only ever sends as itself and waits as itself | Model | `pair send -From claude ...` (when running as agy)
INV-02 | Only the turn-holder acts (edits files, writes memory.md, sends turn-passing messages) | Model | Editing a file when not holding the turn
INV-03 | Navigators never edit files (code, tests, docs) | Model / Rules of conduct | A navigator running a file edit command
INV-04 | `-To` is required whenever more than one possible recipient exists | Model | `pair send -Message 'hello'` in a 3-agent session without `-To`
INV-05 | A turn-passing message is only accepted from the current turn-holder | Message types | `pair send -Turn pass` when not the turn-holder
INV-06 | `handoff` is only accepted from the current driver | Message types | `pair send -Type handoff` when acting as a navigator
INV-07 | An agent may edit files only if it is the driver holding the turn, or the assignee of an active grant strictly within its scope | Work grants | Editing files outside of a grant scope when not the driver
INV-08 | The assignee must accept a grant before editing | Work grants | Editing files after receiving a grant but before running `pair grant-accept`
INV-09 | `-Files` scope requires `-AcceptSharedWorktreeRisk` acknowledgment | Work grants | `pair grant -Files a.txt` without `-AcceptSharedWorktreeRisk`
INV-10 | Assignee working inside a worktree must call commands with `-Root <coordinator repo>` | Work grants | Running `pair grant-done` inside a worktree without `-Root`
INV-11 | Grant traffic always travels with `turn: keep` and never moves the turn token | Work grants | `pair grant -Turn pass`
INV-12 | Exactly one `pair init` is allowed per session | Session lifecycle | Running `pair init` when `.pair/session.json` already has `status: active`
INV-13 | Messages must use paths/summaries and never paste whole files | Rules of conduct | Sending a message containing the full content of a 500-line file
INV-14 | Never rewrite the partner's entries in `memory.md` (append-only) | Rules of conduct | Deleting or modifying a partner's decision in `memory.md`
INV-15 | Never silently take over the partner's role | Rules of conduct | Assuming the driver role without a `handoff`
