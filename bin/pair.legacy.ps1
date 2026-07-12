#Requires -Version 7
<#
claudex pair — file-mailbox pairing protocol between interactive AI CLI agents
(Claude Code, Codex CLI, Antigravity CLI, ...).

N agent sessions (one per terminal pane, n >= 2) exchange turn-based messages
through .pair/inbox/<agent>/ in the target repo. No daemon, no pane control:
an agent "receives" by blocking on `pair wait`, which prints and archives
incoming messages. One driver edits; all other agents are navigators.

Exit codes: 0 = ok / message delivered, 2 = wait timed out (re-run), 1 = error.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('init', 'send', 'wait', 'ask', 'status', 'log', 'watch', 'end', 'help',
                 'grant', 'grants', 'grant-accept', 'grant-done', 'grant-cancel')]
    [string]$Command = 'help',

    # Identity of the calling agent (wait/ask/end). Validated against the
    # session's agent list at runtime.
    [string]$As,

    # Sender/recipient for send. -To defaults to the other agent in two-agent
    # sessions; with three or more agents it is required.
    [string]$From,
    [string]$To,

    [ValidateSet('ask', 'answer', 'handoff', 'review', 'info', 'done')]
    [string]$Type,

    # Message body: inline text, or a file whose content becomes the body.
    [string]$Message,
    [string]$File,

    # 'pass' hands the turn to the recipient; 'keep' sends an FYI without it.
    [ValidateSet('pass', 'keep')][string]$Turn = 'pass',

    # init options. -Agents: comma-separated participant names (2+); known CLI
    # adapters today: claude, codex, agy.
    [string]$Task,
    [string]$Agents = 'claude,codex',
    [string]$Driver = 'claude',

    # wait options. -TimeoutSec 0 = check the inbox once and exit.
    [int]$TimeoutSec = 300,
    [int]$PollSec = 2,

    # log / watch options
    [int]$Tail = 10,
    [int]$RefreshSec = 2,

    # grant options (grants-lite: concurrent work grants, see PROTOCOL.md).
    # -Files mode shares the worktree and is NOT M4-safe; it requires the
    # explicit -AcceptSharedWorktreeRisk acknowledgement.
    [string]$Id,
    [string]$TaskDesc,
    [string]$Files,
    [string]$Worktree,
    [switch]$AcceptSharedWorktreeRisk,
    [string]$AgreedIn,
    [switch]$Json,

    # Repo root containing .pair (default: search upward from cwd).
    [string]$Root
)

$ErrorActionPreference = 'Stop'

function Get-AgentList($session) { @($session.agents) }

function Get-Navigators($session, [string]$driver) {
    @((Get-AgentList $session) | Where-Object { $_ -ne $driver })
}

function Assert-Agent($session, [string]$name, [string]$param) {
    $agents = Get-AgentList $session
    if (-not $name) { throw "$param is required (one of: $($agents -join ', '))" }
    if ($name -notin $agents) {
        throw "'$name' is not a participant in this session (agents: $($agents -join ', ')). Never impersonate another agent."
    }
}

# Default recipient: unambiguous only when exactly one other agent exists
# (n = 2 is the regular case, not a special one).
function Resolve-Recipient($session, [string]$from) {
    $others = @((Get-AgentList $session) | Where-Object { $_ -ne $from })
    if ($others.Count -eq 1) { return $others[0] }
    throw "Ambiguous recipient: specify -To explicitly (one of: $($others -join ', '))"
}

function Find-PairDir {
    if ($Root) {
        $dir = (Resolve-Path $Root).Path
        $candidate = Join-Path $dir '.pair'
        if (Test-Path (Join-Path $candidate 'session.json')) { return $candidate }
        throw "No .pair/session.json under -Root $Root. Run: pair init -Task '...'"
    }
    $dir = (Get-Location).Path
    while ($dir) {
        $candidate = Join-Path $dir '.pair'
        if (Test-Path (Join-Path $candidate 'session.json')) { return $candidate }
        $parent = Split-Path $dir -Parent
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    throw "No active pairing session found (.pair/session.json in cwd or any parent). Run: pair init -Task '...'"
}

function Get-Session([string]$pairDir) {
    Get-Content (Join-Path $pairDir 'session.json') -Raw | ConvertFrom-Json
}

function Save-Session([string]$pairDir, $session) {
    $json = $session | ConvertTo-Json -Depth 5
    $tmp = Join-Path $pairDir 'session.json.tmp'
    [System.IO.File]::WriteAllText($tmp, $json)
    Move-Item -Force $tmp (Join-Path $pairDir 'session.json')
}

# Write message atomically: temp file in .pair, then rename into the inbox so
# a polling reader never sees a partial file.
function Send-PairMessage([string]$pairDir, [string]$from, [string]$to, [string]$type, [string]$turnMode, [string]$body, [bool]$allowCompleted = $false) {
    $session = Get-Session $pairDir
    if ($session.status -ne 'active' -and -not $allowCompleted) {
        throw "Session status is '$($session.status)' — no messages can be sent. Start a new session with: pair init"
    }
    Assert-Agent $session $from '-From'
    Assert-Agent $session $to '-To'
    if ($from -eq $to) { throw "-From and -To must differ (both were '$from')" }
    if ($turnMode -eq 'pass' -and $session.turn -ne $from) {
        throw "It is $($session.turn)'s turn; '$from' cannot send a turn-passing message. Use -Turn keep for an FYI, or wait for the turn."
    }
    if ($type -eq 'handoff' -and $session.driver -ne $from) {
        throw "Only the driver ($($session.driver)) may send handoff (you are '$from')."
    }
    $id = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $name = "$id-$from-$type.md"
    $lines = @(
        '---'
        "id: $id"
        "from: $from"
        "to: $to"
        "type: $type"
        "turn: $turnMode"
        "sent: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        '---'
        ''
        $body
        ''
    )
    $tmp = Join-Path $pairDir "$name.tmp"
    [System.IO.File]::WriteAllText($tmp, ($lines -join "`n"))
    Move-Item $tmp (Join-Path $pairDir "inbox\$to\$name")

    if ($turnMode -eq 'pass') { $session.turn = $to }
    if ($type -eq 'handoff') {
        $session.driver = $to
        $session.navigators = Get-Navigators $session $to
    }
    if ($type -eq 'done') { $session.status = 'completed' }
    Save-Session $pairDir $session
    return @{ name = $name; session = $session }
}

function Get-Body {
    if ($File) { return (Get-Content $File -Raw) }
    if ($Message) { return $Message }
    throw "Provide the message body via -Message '...' or -File <path> (use -File for anything long or with tricky quoting)."
}

function Cmd-Init {
    if (-not $Task) { throw "init requires -Task '<what the agents are building>'" }
    $agentList = @($Agents -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
    if ($agentList.Count -lt 2) { throw "init requires at least two agents (-Agents 'claude,codex[,agy,...]')" }
    if (@($agentList | Select-Object -Unique).Count -ne $agentList.Count) { throw "agent names must be unique (got: $($agentList -join ', '))" }
    foreach ($a in $agentList) {
        if ($a -notmatch '^[a-z][a-z0-9_-]{0,15}$') { throw "invalid agent name '$a' (lowercase letter first, then letters/digits/dash/underscore, max 16 chars)" }
    }
    if ($Driver -notin $agentList) { throw "driver '$Driver' must be one of the agents: $($agentList -join ', ')" }
    $base = if ($Root) { (Resolve-Path $Root).Path } else { (Get-Location).Path }
    $pairDir = Join-Path $base '.pair'
    if (Test-Path (Join-Path $pairDir 'session.json')) {
        $existing = Get-Session $pairDir
        if ($existing.status -eq 'active') {
            throw "An active session already exists here (task: $($existing.task)). Finish it with 'pair end' or delete .pair first."
        }
    }
    $dirs = @($agentList | ForEach-Object { "inbox\$_" }) + 'archive'
    foreach ($d in $dirs) {
        New-Item -ItemType Directory -Force (Join-Path $pairDir $d) | Out-Null
    }
    $navigators = @($agentList | Where-Object { $_ -ne $Driver })
    $session = [ordered]@{
        task       = $Task
        agents     = $agentList
        driver     = $Driver
        navigators = $navigators
        turn       = $Driver
        status     = 'active'
        started    = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    }
    Save-Session $pairDir ([pscustomobject]$session)

    $memoryPath = Join-Path $pairDir 'memory.md'
    if (-not (Test-Path $memoryPath)) {
        $memory = @"
# Pair session memory

Shared long-lived context for this pairing session. Append-only while the
session runs; only the current turn-holder writes here. Never rewrite or
delete your partner's entries.

## Task

$Task

## Ground rules

- The driver edits code; navigators review and direct but do not edit files.
- Keep messages short and concrete; reference code as path:line.
- Record durable decisions under Decisions before passing the turn.

## Decisions

<!-- - [claude 14:03] chose X over Y because Z -->

## Open questions

## Handoff notes
"@
        [System.IO.File]::WriteAllText($memoryPath, $memory)
    }

    # Keep session state out of version control.
    $gitignore = Join-Path $base '.gitignore'
    if ((Test-Path $gitignore) -and -not (Select-String -Path $gitignore -Pattern '^\.pair/' -Quiet -ErrorAction SilentlyContinue)) {
        Add-Content $gitignore "`n.pair/"
        Write-Output "Added .pair/ to .gitignore."
    }

    Write-Output "Pairing session initialized in $pairDir"
    Write-Output "  Task:      $Task"
    Write-Output "  Agents:    $($agentList -join ', ')"
    Write-Output "  Driver:    $Driver    Navigators: $($navigators -join ', ')    Turn: $Driver"
    Write-Output ''
    Write-Output 'Next: in each other pane, tell that agent to join the pairing session (/pair in Claude Code and agy, $pair in Codex).'
}

function Cmd-Send {
    $pairDir = Find-PairDir
    $session = Get-Session $pairDir
    if (-not $From) { throw "send requires -From <you> (one of: $((Get-AgentList $session) -join ', ')) — never impersonate a partner" }
    if (-not $To) { $To = Resolve-Recipient $session $From }
    if (-not $Type) { $Type = 'info' }
    $body = Get-Body
    $result = Send-PairMessage $pairDir $From $To $Type $Turn $body
    $s = $result.session
    Write-Output "Sent $Type -> $To ($($result.name)). Turn: $($s.turn). Driver: $($s.driver). Status: $($s.status)."
    if ($Turn -eq 'pass') {
        Write-Output "You handed over the turn. Now block on: pair wait -As $From"
    }
}

function Cmd-Wait {
    $pairDir = Find-PairDir
    Assert-Agent (Get-Session $pairDir) $As '-As'
    $inbox = Join-Path $pairDir "inbox\$As"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        $msgs = Get-ChildItem $inbox -Filter '*.md' -ErrorAction SilentlyContinue | Sort-Object Name
        if ($msgs) {
            foreach ($m in $msgs) {
                Write-Output ('=' * 66)
                Write-Output "INCOMING $($m.Name)"
                Write-Output ('-' * 66)
                Write-Output (Get-Content $m.FullName -Raw)
                Move-Item $m.FullName (Join-Path $pairDir 'archive' $m.Name)
            }
            $session = Get-Session $pairDir
            Write-Output ('=' * 66)
            if ($session.status -ne 'active') {
                Write-Output "SESSION $($session.status.ToUpper()) — your partner ended the session. Wrap up and report to the user; do not wait again."
            }
            elseif ($session.turn -eq $As) {
                $role = if ($session.driver -eq $As) { 'DRIVER' } else { 'NAVIGATOR' }
                Write-Output "It is now YOUR turn, $As. Your role: $role. Act on the message, then send a reply (turn: pass) and wait again."
            }
            else {
                Write-Output "FYI only — the turn stays with $($session.turn). Note the content and continue what you were doing."
            }
            exit 0
        }
        if ((Get-Date) -ge $deadline) {
            Write-Output "No message after ${TimeoutSec}s; your partner is likely still working. Re-run: pair wait -As $As -TimeoutSec $TimeoutSec"
            exit 2
        }
        Start-Sleep -Seconds $PollSec
    }
}

function Cmd-Ask {
    # send (default type: ask) + immediately block for the reply.
    if (-not $From) {
        if ($As) { $script:From = $As } else { throw 'ask requires -From <your own agent name>' }
    }
    if (-not $Type) { $script:Type = 'ask' }
    Cmd-Send
    $script:As = $From
    Cmd-Wait
}

function Cmd-Status {
    $pairDir = Find-PairDir
    $s = Get-Session $pairDir
    Write-Output "Task:      $($s.task)"
    Write-Output "Status:    $($s.status)   (started $($s.started))"
    Write-Output "Agents:    $((Get-AgentList $s) -join ', ')"
    Write-Output "Driver:    $($s.driver)   Navigators: $(@($s.navigators) -join ', ')   Turn: $($s.turn)"
    foreach ($agent in (Get-AgentList $s)) {
        $pending = @(Get-ChildItem (Join-Path $pairDir "inbox\$agent") -Filter '*.md' -ErrorAction SilentlyContinue)
        Write-Output "Inbox ${agent}: $($pending.Count) pending$(if ($pending) { ' — ' + (($pending | Sort-Object Name | Select-Object -ExpandProperty Name) -join ', ') })"
    }
    $recent = Get-ChildItem (Join-Path $pairDir 'archive') -Filter '*.md' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 3
    if ($recent) { Write-Output "Recent:    $(($recent | Select-Object -ExpandProperty Name) -join ', ')" }
    $open = @(Get-ChildItem (Join-Path $pairDir 'grants') -Filter '*.json' -ErrorAction SilentlyContinue |
        ForEach-Object { Read-Grant $_.FullName } | Where-Object { $_.state -in 'offered', 'active' })
    if ($open) {
        Write-Output "Grants:    $(($open | ForEach-Object { "$($_.id) [$($_.state)] -> $($_.assignee)" }) -join '; ')"
    }
}

function Cmd-Log {
    $pairDir = Find-PairDir
    $msgs = Get-ChildItem (Join-Path $pairDir 'archive') -Filter '*.md' -ErrorAction SilentlyContinue |
        Sort-Object Name | Select-Object -Last $Tail
    if (-not $msgs) { Write-Output 'No archived messages yet.'; return }
    foreach ($m in $msgs) {
        Write-Output ('=' * 66)
        Write-Output $m.Name
        Write-Output ('-' * 66)
        Write-Output (Get-Content $m.FullName -Raw)
    }
}

# Live read-only dashboard for a human's terminal pane. Renders session state
# plus the message stream (archive = delivered, inbox = pending) and refreshes
# in place. Ctrl+C to exit; never modifies session state.
function Cmd-Watch {
    $pairDir = Find-PairDir
    $esc = [char]27
    $reset = "$esc[0m"; $dim = "$esc[2m"; $bold = "$esc[1m"
    # Stable palette assigned by agent order: yellow, cyan, green, magenta, blue, red.
    $palette = @("$esc[33m", "$esc[36m", "$esc[32m", "$esc[35m", "$esc[34m", "$esc[31m")
    $agentColor = @{}
    $i = 0
    foreach ($a in (Get-AgentList (Get-Session $pairDir))) {
        $agentColor[$a] = $palette[$i % $palette.Count]; $i++
    }
    $lastFrame = ''
    try { [Console]::CursorVisible = $false } catch {}
    try {
        while ($true) {
            $s = Get-Session $pairDir
            $width = try { [Math]::Max(60, $Host.UI.RawUI.WindowSize.Width - 1) } catch { 100 }
            $out = [System.Text.StringBuilder]::new()

            [void]$out.AppendLine("$bold claudex pair — $($s.task)$reset")
            $statusColor = if ($s.status -eq 'active') { "$esc[32m" } else { "$esc[31m" }
            $navList = (@($s.navigators) | ForEach-Object { "$($agentColor[$_])$_$reset" }) -join ', '
            [void]$out.AppendLine(" status: $statusColor$($s.status)$reset   driver: $($agentColor[$s.driver])$($s.driver)$reset   navigators: $navList   turn: $($agentColor[$s.turn])$bold$($s.turn)$reset")
            $openGrants = @(Get-ChildItem (Join-Path $pairDir 'grants') -Filter '*.json' -ErrorAction SilentlyContinue |
                ForEach-Object { Read-Grant $_.FullName } | Where-Object { $_.state -in 'offered', 'active' })
            if ($openGrants) {
                $gLine = ($openGrants | ForEach-Object { "$($agentColor[$_.assignee])$($_.assignee)$reset$dim [$($_.state)] $($_.id)$reset" }) -join '   '
                [void]$out.AppendLine(" grants: $gLine")
            }
            [void]$out.AppendLine($dim + ('─' * $width) + $reset)

            # Delivered messages (archive) then pending ones (inboxes), oldest first.
            $delivered = Get-ChildItem (Join-Path $pairDir 'archive') -Filter '*.md' -ErrorAction SilentlyContinue |
                ForEach-Object { [pscustomobject]@{ File = $_; Pending = $false } }
            $pending = foreach ($agent in (Get-AgentList $s)) {
                Get-ChildItem (Join-Path $pairDir "inbox\$agent") -Filter '*.md' -ErrorAction SilentlyContinue |
                    ForEach-Object { [pscustomobject]@{ File = $_; Pending = $true } }
            }
            $all = @($delivered) + @($pending) | Where-Object { $_ } | Sort-Object { $_.File.Name } | Select-Object -Last $Tail

            if (-not $all) {
                [void]$out.AppendLine("$dim (no messages yet)$reset")
            }
            foreach ($entry in $all) {
                $raw = Get-Content $entry.File.FullName -Raw
                $meta = @{}
                $body = $raw
                if ($raw -match '(?s)^---\r?\n(.*?)\r?\n---\r?\n?(.*)$') {
                    $headerBlock = $Matches[1]
                    $body = $Matches[2].Trim()
                    foreach ($line in ($headerBlock -split "\r?\n")) {
                        if ($line -match '^(\w+):\s*(.*)$') { $meta[$Matches[1]] = $Matches[2] }
                    }
                }
                $from = if ($meta['from']) { $meta['from'] } else { '?' }
                $c = if ($agentColor.ContainsKey($from)) { $agentColor[$from] } else { '' }
                $flag = if ($entry.Pending) { " $esc[35m[undelivered]$reset" } else { '' }
                [void]$out.AppendLine('')
                [void]$out.AppendLine("$c$bold$from$reset $dim-> $($meta['to']) | $($meta['type']) | turn:$($meta['turn']) | $($meta['sent'])$reset$flag")
                foreach ($bline in ($body -split "\r?\n")) {
                    while ($bline.Length -gt $width - 3) {
                        [void]$out.AppendLine("   $($bline.Substring(0, $width - 3))")
                        $bline = $bline.Substring($width - 3)
                    }
                    [void]$out.AppendLine("   $bline")
                }
            }
            [void]$out.AppendLine('')
            [void]$out.AppendLine($dim + ('─' * $width) + $reset)
            [void]$out.AppendLine("$dim refresh ${RefreshSec}s | last $Tail messages | Ctrl+C to exit$reset")

            $frame = $out.ToString()
            if ($frame -ne $lastFrame) {
                # ANSI clear+home instead of Clear-Host: works with redirected output too.
                Write-Host "$esc[2J$esc[H$frame" -NoNewline
                $lastFrame = $frame
            }
            Start-Sleep -Seconds $RefreshSec
        }
    }
    finally {
        try { [Console]::CursorVisible = $true } catch {}
    }
}

function Cmd-End {
    $pairDir = Find-PairDir
    $session = Get-Session $pairDir
    Assert-Agent $session $As '-As'
    $summary = if ($Message -or $File) { Get-Body } else { 'Session ended.' }
    $memoryPath = Join-Path $pairDir 'memory.md'
    Add-Content $memoryPath "`n## Session ended $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') by $As`n`n$summary"
    # Every other agent gets the done notice; the first send flips the session
    # to completed, so later sends must be allowed through explicitly.
    $others = @((Get-AgentList $session) | Where-Object { $_ -ne $As })
    $names = foreach ($o in $others) {
        (Send-PairMessage $pairDir $As $o 'done' 'keep' $summary $true).name
    }
    Write-Output "Session completed. Final summary appended to memory.md and sent to $($others -join ', ') ($($names -join ', '))."
}

# ── grants-lite ─────────────────────────────────────────────────────────────
# Concurrent work grants (interim, file-only shape of ENHANCEMENTS.md M3/M4).
# One JSON file per grant in .pair/grants/. Every state transition runs under a
# per-grant lock file (CreateNew) because issuer (cancel) and assignee
# (accept/done) can legitimately race on the same grant.

function Assert-ActiveSession($session) {
    if ($session.status -ne 'active') {
        throw "Session status is '$($session.status)' — grant operations require an active session."
    }
}

function Get-GrantsDir([string]$pairDir) {
    $d = Join-Path $pairDir 'grants'
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }
    return $d
}

function Get-GrantPath([string]$pairDir, [string]$grantId) {
    $p = Join-Path (Get-GrantsDir $pairDir) "$grantId.json"
    if (-not (Test-Path $p)) { throw "No grant '$grantId' (see: pair grants)" }
    return $p
}

function Read-Grant([string]$path) { Get-Content $path -Raw | ConvertFrom-Json }

function Write-Grant([string]$path, $grant) {
    $tmp = "$path.$PID.tmp"
    [System.IO.File]::WriteAllText($tmp, ($grant | ConvertTo-Json -Depth 5))
    Move-Item -Force $tmp $path
}

# Serialize a read-validate-write transition on one grant. $action receives the
# grant object, mutates it, and returns it; expected-state mismatches throw.
function Invoke-GrantTransition([string]$pairDir, [string]$grantId, [string[]]$expectedStates, [scriptblock]$action) {
    $path = Get-GrantPath $pairDir $grantId
    $lockPath = "$path.lock"
    $lock = $null
    for ($try = 0; $try -lt 40; $try++) {
        try {
            $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew)
            break
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $lock) { throw "Could not lock grant '$grantId' after 10s; if no other transition is running, delete $lockPath" }
    try {
        # Re-check under the lock: the session may have completed since the
        # caller's precondition check.
        Assert-ActiveSession (Get-Session $pairDir)
        $grant = Read-Grant $path
        if ($grant.state -notin $expectedStates) {
            throw "Grant '$grantId' is '$($grant.state)' (expected: $($expectedStates -join '|')) — stale transition rejected"
        }
        $grant = & $action $grant
        $grant.revision = [int]$grant.revision + 1
        $grant.updated = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Write-Grant $path $grant
        return $grant
    }
    finally {
        $lock.Close()
        Remove-Item -Force $lockPath -ErrorAction SilentlyContinue
    }
}

function Cmd-Grant {
    $pairDir = Find-PairDir
    $session = Get-Session $pairDir
    Assert-ActiveSession $session
    Assert-Agent $session $From '-From'
    Assert-Agent $session $To '-To'
    if ($From -ne $session.driver) { throw "Only the driver ($($session.driver)) may issue grants (you are '$From')." }
    if ($From -eq $To) { throw 'Cannot grant work to yourself; the driver already edits under the turn.' }
    if (-not $TaskDesc) { throw "grant requires -TaskDesc '<what the assignee should do>'" }
    if ($Worktree -and $Files) { throw 'Scope is either -Worktree <path> or -Files a,b,c — not both.' }
    if (-not $Worktree -and -not $Files) { throw 'grant requires a scope: -Worktree <path> (isolated) or -Files a,b,c (shared worktree, needs -AcceptSharedWorktreeRisk).' }
    if ($Files -and -not $AcceptSharedWorktreeRisk) {
        throw 'A -Files scope shares the worktree: nothing mechanically stops overlapping edits (NOT M4-safe). All agents must have agreed the file sets are disjoint; acknowledge with -AcceptSharedWorktreeRisk.'
    }
    $fileList = @()
    if ($Files) {
        $fileList = @($Files -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
        if ($fileList.Count -eq 0) { throw "-Files contained no usable entries (got '$Files')" }
    }
    $grantId = "g$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$To"
    $scope = if ($Worktree) {
        [ordered]@{ mode = 'worktree'; worktree = $Worktree }
    } else {
        [ordered]@{ mode = 'files'; files = $fileList }
    }
    $grant = [pscustomobject][ordered]@{
        id        = $grantId
        issuer    = $From
        assignee  = $To
        task      = $TaskDesc
        scope     = [pscustomobject]$scope
        state     = 'offered'
        agreed_in = $AgreedIn
        result    = ''
        revision  = 0
        created   = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        updated   = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    }
    # CreateNew: a colliding grant id must fail loudly, never overwrite.
    $grantPath = Join-Path (Get-GrantsDir $pairDir) "$grantId.json"
    try {
        $fs = [System.IO.File]::Open($grantPath, [System.IO.FileMode]::CreateNew)
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(($grant | ConvertTo-Json -Depth 5))
            $fs.Write($bytes, 0, $bytes.Length)
        } finally { $fs.Close() }
    } catch [System.IO.IOException] {
        throw "Grant id collision for '$grantId' — re-run the grant command."
    }
    $scopeText = if ($Worktree) { "worktree $Worktree" } else { "files: $($scope.files -join ', ') (shared worktree — stay strictly inside this list)" }
    $body = "WORK GRANT $grantId`nTask: $TaskDesc`nScope: $scopeText`n`nAccept with: pair grant-accept -As $To -Id $grantId`nThen work the task (editing allowed within scope only, even without the turn), and finish with: pair grant-done -As $To -Id $grantId -Message '<result summary>'"
    Send-PairMessage $pairDir $From $To 'grant' 'keep' $body | Out-Null
    Write-Output "Grant $grantId offered to $To ($($scope.mode) scope). The conversation turn is unaffected."
}

function Cmd-GrantAccept {
    $pairDir = Find-PairDir
    $session = Get-Session $pairDir
    Assert-ActiveSession $session
    Assert-Agent $session $As '-As'
    if (-not $Id) { throw 'grant-accept requires -Id <grant id>' }
    $grant = Invoke-GrantTransition $pairDir $Id @('offered') {
        param($g)
        if ($g.assignee -ne $As) { throw "Grant '$($g.id)' is assigned to $($g.assignee), not '$As'" }
        $g.state = 'active'
        $g
    }.GetNewClosure()
    Write-Output "Grant $Id is ACTIVE. You may edit strictly within its scope ($($grant.scope.mode)); finish with: pair grant-done -As $As -Id $Id -Message '<result>'"
}

function Cmd-GrantDone {
    $pairDir = Find-PairDir
    $session = Get-Session $pairDir
    Assert-ActiveSession $session
    Assert-Agent $session $As '-As'
    if (-not $Id) { throw 'grant-done requires -Id <grant id>' }
    $result = if ($Message -or $File) { Get-Body } else { throw "grant-done requires -Message/-File '<what was done, files touched, how verified>'" }
    $grant = Invoke-GrantTransition $pairDir $Id @('active') {
        param($g)
        if ($g.assignee -ne $As) { throw "Grant '$($g.id)' is assigned to $($g.assignee), not '$As'" }
        $g.state = 'done'
        $g.result = $result
        $g
    }.GetNewClosure()
    Send-PairMessage $pairDir $As $grant.issuer 'grant-done' 'keep' "GRANT $Id COMPLETE`n$result" | Out-Null
    Write-Output "Grant $Id done; issuer $($grant.issuer) notified. Stop editing its scope now."
}

function Cmd-GrantCancel {
    $pairDir = Find-PairDir
    $session = Get-Session $pairDir
    Assert-ActiveSession $session
    Assert-Agent $session $As '-As'
    if ($As -ne $session.driver) { throw "Only the driver ($($session.driver)) may cancel grants." }
    if (-not $Id) { throw 'grant-cancel requires -Id <grant id>' }
    $grant = Invoke-GrantTransition $pairDir $Id @('offered', 'active') {
        param($g)
        $g.state = 'cancelled'
        if ($Message) { $g.result = $Message }
        $g
    }.GetNewClosure()
    Send-PairMessage $pairDir $As $grant.assignee 'grant-cancel' 'keep' "GRANT $Id CANCELLED by $As.$(if ($Message) { " Reason: $Message" }) Stop editing its scope immediately." | Out-Null
    Write-Output "Grant $Id cancelled; $($grant.assignee) notified."
}

function Cmd-Grants {
    $pairDir = Find-PairDir
    $grants = @(Get-ChildItem (Join-Path $pairDir 'grants') -Filter '*.json' -ErrorAction SilentlyContinue |
        Sort-Object Name | ForEach-Object { Read-Grant $_.FullName })
    if ($Json) { $grants | ConvertTo-Json -Depth 5 -AsArray; return }
    if (-not $grants) { Write-Output 'No grants in this session.'; return }
    foreach ($g in $grants) {
        $scopeText = if ($g.scope.mode -eq 'worktree') { "worktree $($g.scope.worktree)" } else { "files: $($g.scope.files -join ', ')" }
        Write-Output "$($g.id)  [$($g.state)]  $($g.issuer) -> $($g.assignee)  $scopeText"
        Write-Output "    task: $($g.task)$(if ($g.result) { "`n    result: $($g.result)" })"
    }
}

function Cmd-Help {
    Write-Output @'
claudex pair — turn-based pairing between AI CLI agents (claude, codex, agy, ...)

Usage:
  pair init   -Task '<goal>' [-Agents 'claude,codex[,agy,...]'] [-Driver <agent>] [-Root <repo>]
  pair send   -From <me> [-To <agent>] [-Type ask|answer|handoff|review|info]
              (-Message '<text>' | -File <path>) [-Turn pass|keep]
              # -To required when more than one possible recipient
  pair wait   -As <me> [-TimeoutSec 300] [-PollSec 2]      # 0 = check once
  pair ask    -From <me> (-Message '<text>' | -File <path>) # send ask + wait
  pair status
  pair log    [-Tail 10]
  pair watch  [-Tail 10] [-RefreshSec 2]   # live dashboard (for the human's pane)
  pair end    -As <me> [-Message '<summary>']   # notifies every other agent

Work grants (grants-lite — parallel editing; driver-only issuance):
  pair grant        -From <driver> -To <agent> -TaskDesc '<task>'
                    (-Worktree <path> | -Files a,b,c -AcceptSharedWorktreeRisk)
                    [-AgreedIn <message-id>]
  pair grants       [-Json]                      # list all grants
  pair grant-accept -As <me> -Id <grant-id>      # offered -> active, then edit within scope
  pair grant-done   -As <me> -Id <grant-id> -Message '<result>'
  pair grant-cancel -As <driver> -Id <grant-id> [-Message '<reason>']
  Grant traffic never moves the conversation turn. -Files scopes share the
  worktree and are advisory only (NOT M4-safe); -Worktree scopes are isolated.

Message types:
  ask      question or request needing a reply
  answer   reply to an ask
  review   review verdict on the driver's work
  handoff  the RECIPIENT becomes driver; everyone else navigates
  info     FYI, usually with -Turn keep
  done     session complete (sent by 'pair end')

Exit codes: 0 ok, 2 wait timed out (re-run wait), 1 error.
State lives in .pair/ at the repo root; protocol spec in the claudex repo.
'@
}

switch ($Command) {
    'init'         { Cmd-Init }
    'send'         { Cmd-Send }
    'wait'         { Cmd-Wait }
    'ask'          { Cmd-Ask }
    'status'       { Cmd-Status }
    'log'          { Cmd-Log }
    'watch'        { Cmd-Watch }
    'end'          { Cmd-End }
    'grant'        { Cmd-Grant }
    'grants'       { Cmd-Grants }
    'grant-accept' { Cmd-GrantAccept }
    'grant-done'   { Cmd-GrantDone }
    'grant-cancel' { Cmd-GrantCancel }
    default        { Cmd-Help }
}
