#requires -Version 5.1
<#
.SYNOPSIS
Install the local Codex Chat Context plugin. No administrator rights required.
.DESCRIPTION
Finds Node.js and a plugin-capable Codex CLI, configures absolute paths, then
registers the marketplace and installs the plugin. Run again after moving or
updating the checkout. Dependencies are checked, never downloaded automatically.
#>
[CmdletBinding()]
param(
    [string]$NodePath,
    [string]$CodexPath
)

$ErrorActionPreference = 'Stop'
# Native exit codes are checked below on both Windows PowerShell and PowerShell 7.
$PSNativeCommandUseErrorActionPreference = $false

function Resolve-Program([string]$Value) {
    if (Test-Path -LiteralPath $Value -PathType Leaf) {
        return (Resolve-Path -LiteralPath $Value).ProviderPath
    }
    $found = Get-Command $Value -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
    throw "Executable not found: $Value"
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    $output = & $Executable @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $Executable $($Arguments -join ' ')`n$($output -join "`n")"
    }
    return $output
}

$originalConfig = $null
$configWritten = $false
try {
    if ($env:OS -ne 'Windows_NT') { throw 'This installer currently supports Windows only.' }
    $marketplace = Join-Path $PSScriptRoot 'marketplace'
    $pluginRoot = Join-Path $marketplace 'plugins/context-panel-probe'
    $serverPath = (Resolve-Path -LiteralPath (Join-Path $pluginRoot 'server.cjs')).ProviderPath
    $configPath = (Resolve-Path -LiteralPath (Join-Path $pluginRoot '.mcp.json')).ProviderPath

    if (-not $NodePath) { $NodePath = 'node' }
    $nodeExe = Resolve-Program $NodePath
    $nodeVersion = (Invoke-Checked $nodeExe @('--version') | Out-String).Trim()
    if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
        throw "Node.js 20 or later is required. Found: $nodeVersion"
    }
    $null = Invoke-Checked $nodeExe @('--check', $serverPath)

    $candidates = @()
    if ($CodexPath) {
        $candidates = @(Resolve-Program $CodexPath)
    } else {
        $onPath = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($onPath) { $candidates += $onPath.Source }
        if ($env:LOCALAPPDATA) {
            $bundled = Join-Path $env:LOCALAPPDATA 'OpenAI/Codex/bin'
            $candidates += @(Get-ChildItem -LiteralPath $bundled -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -ExpandProperty FullName)
        }
    }
    $codexExe = $null
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        try {
            $null = Invoke-Checked $candidate @('plugin', 'marketplace', 'add', '--help')
            $null = Invoke-Checked $candidate @('plugin', 'add', '--help')
            $codexExe = $candidate
            break
        } catch {
            if ($CodexPath) { throw }
            Write-Host "Skipping incompatible CLI: $candidate"
        }
    }
    if (-not $codexExe) { throw 'No plugin-capable Codex CLI found. Install/update Codex Desktop or pass -CodexPath.' }

    Write-Host "Node: $nodeExe ($nodeVersion)"
    Write-Host "Codex: $codexExe"
    Write-Host "Server: $serverPath"
    $originalConfig = [IO.File]::ReadAllBytes($configPath)
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $server = $config.mcpServers.context_panel_probe
    if (-not $server) { throw 'Missing mcpServers.context_panel_probe in .mcp.json.' }
    # Preserve additional settings and unrelated MCP servers.
    if ($server.command -cne $nodeExe -or @($server.args).Count -ne 1 -or $server.args[0] -cne $serverPath -or $server.enabled -ne $true) {
        $server.command = $nodeExe
        $server.args = @($serverPath)
        $server.enabled = $true
        $json = $config | ConvertTo-Json -Depth 30
        $configWritten = $true
        [IO.File]::WriteAllText($configPath, $json + "`n", [Text.UTF8Encoding]::new($false))
    }

    Invoke-Checked $codexExe @('plugin', 'marketplace', 'add', $marketplace) | ForEach-Object { Write-Host $_ }
    Invoke-Checked $codexExe @('plugin', 'add', 'context-panel-probe@context-panel-probe-local') | ForEach-Object { Write-Host $_ }
    Write-Host 'Installation complete. Fully restart Codex, then select @Context Panel Probe and ask to open the context panel.'
    exit 0
} catch {
    $failure = $_.Exception.Message
    if ($configWritten -and $null -ne $originalConfig) {
        try { [IO.File]::WriteAllBytes($configPath, $originalConfig) }
        catch { Write-Warning "Could not restore .mcp.json: $($_.Exception.Message)" }
    }
    [Console]::Error.WriteLine("Installation failed: $failure")
    exit 1
}
