#Requires -Version 7
<#
claudex pair — thin shim. The implementation is the TypeScript CLI
(src/apps/cli/main.ts, per docs/ARCHITECTURE.md); this script only finds the
best available runtime and passes arguments through verbatim.
Prefers the compiled binary (dist/pair.exe), falls back to bun.
The original PowerShell implementation is preserved at bin/pair.legacy.ps1.
#>
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root 'dist\pair.exe'
if (Test-Path $exe) {
    & $exe @args
    exit $LASTEXITCODE
}
$bun = Get-Command bun -ErrorAction SilentlyContinue
if ($bun) {
    & $bun.Source run (Join-Path $root 'src\apps\cli\main.ts') @args
    exit $LASTEXITCODE
}
Write-Error 'claudex: neither dist/pair.exe nor bun found. Build with: bun run build'
exit 1
