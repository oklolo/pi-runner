$ErrorActionPreference = 'Stop'
$work = $PSScriptRoot
$commit = Join-Path $work 'commit'
$backup = Join-Path $work 'previous'
$stage = Join-Path $work 'next'
$restartRestoredApp = $false
function Assert-Inventory([string] $root, $inventory) {
    $expected = @{}
    $dirs = @{}
    foreach ($name in $inventory.directories) { $dirs[$name] = $true }
    foreach ($item in $inventory.files.PSObject.Properties) {
        $expected[$item.Name] = $item.Value
        $parent = Split-Path -Parent $item.Name
        while ($parent) {
            $dirs[$parent.Replace('\','/')] = $true
            $parent = Split-Path -Parent $parent
        }
    }
    $pending = [Collections.Generic.Queue[string]]::new()
    if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe root' }
    $pending.Enqueue($root)
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath ($pending.Dequeue()) -Force) {
            $name = $item.FullName.Substring($root.Length + 1).Replace('\','/')
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point: $name" }
            if ($item.PSIsContainer) {
                if (!$dirs.ContainsKey($name)) { throw "Unexpected directory: $name" }
                $pending.Enqueue($item.FullName)
            } else {
                if (!$expected.ContainsKey($name)) { throw "Unexpected file: $name" }
                if ((Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -ne $expected[$name]) { throw "Changed file: $name" }
                $expected.Remove($name)
            }
        }
    }
    if ($expected.Count) { throw ('Missing file: ' + ($expected.Keys | Select-Object -First 1)) }
}
function Get-UpdatedExecutable([string] $root) {
    $exe = Join-Path $root $job.exe
    $actual = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    $version = '{0}.{1}.{2}' -f $actual.FileMajorPart, $actual.FileMinorPart, $actual.FileBuildPart
    if ($version -ne $job.version) { throw "Executable version is $version; expected $($job.version)" }
    return $exe
}
function Move-UpdateDirectory([string] $source, [string] $destination) {
    # Electron child processes and antivirus scanners can briefly hold directory handles.
    for ($attempt = 0; ; $attempt++) {
        try { [IO.Directory]::Move($source, $destination); return } catch {
            if ($attempt -ge 20 -or ![IO.Directory]::Exists($source) -or [IO.Directory]::Exists($destination)) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}
function Stop-UpdateProcess([Diagnostics.Process] $child) {
    if (!$child.HasExited) {
        try { $child.Kill() } catch { if (!$child.HasExited) { throw } }
        if (!$child.WaitForExit(5000)) { throw 'Could not stop the update process' }
    }
}
function Start-AppProcess([string] $exe, [string] $root, [string] $startupDirectory) {
    # Start-Process in Windows PowerShell 5.1 interprets brackets in the working directory as wildcards.
    $start = [Diagnostics.ProcessStartInfo]::new($exe)
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    if ($startupDirectory) { $start.EnvironmentVariables['PI_RUNNER_UPDATE_STARTUP_DIR'] = $startupDirectory }
    return [Diagnostics.Process]::Start($start)
}
function Start-UpdatedApp([string] $root) {
    $startupDirectory = if ($job.startupAck) { $work } else { '' }
    $updated = Start-AppProcess (Get-UpdatedExecutable $root) $root $startupDirectory
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        if ($updated.WaitForExit(5000)) { throw "Updated app exited immediately (exit code $($updated.ExitCode))" }
        if (!$startupDirectory) { return }
        $appReady = Join-Path $work 'app-ready'
        while ($timer.ElapsedMilliseconds -lt 60000) {
            if ($updated.HasExited) { throw "Updated app exited before startup completed (exit code $($updated.ExitCode))" }
            if ([IO.File]::Exists($appReady)) { return }
            Start-Sleep -Milliseconds 200
        }
        Stop-UpdateProcess $updated
        throw 'Timed out waiting for the updated app to start'
    } finally {
        $updated.Dispose()
    }
}
try {
    $job = Get-Content -LiteralPath (Join-Path $work 'job.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $process = Get-Process -Id $job.pid
    # Acquire a process handle while the main app is alive; do not reopen a potentially reused PID.
    $null = $process.Handle
    if ($job.installer) {
        if ((Get-Item -LiteralPath $job.root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe root' }
        if ((Get-FileHash -LiteralPath $job.installer -Algorithm SHA512).Hash -ne $job.hash) { throw 'Invalid installer hash' }
    } else {
        Assert-Inventory $job.root $job.currentInventory
        Assert-Inventory $stage $job.nextInventory
        $null = Get-UpdatedExecutable $stage
    }
    [IO.File]::WriteAllText((Join-Path $work 'ready'), '')
    if (!$process.WaitForExit(120000)) { throw 'Timed out waiting for Pi Runner' }
    if (!(Test-Path -LiteralPath $commit -PathType Leaf)) { throw 'Update was not committed' }
    $restartRestoredApp = $true
    if ($job.installer) {
        if ((Get-FileHash -LiteralPath $job.installer -Algorithm SHA512).Hash -ne $job.hash) { throw 'Invalid installer hash' }
        [void][IO.Directory]::CreateDirectory($stage)
        $start = [Diagnostics.ProcessStartInfo]::new($job.installer)
        # NSIS requires /D= to be last and unquoted, even when the path contains spaces.
        $start.Arguments = "/S /D=$stage"
        $start.WorkingDirectory = $work
        $start.UseShellExecute = $false
        $start.EnvironmentVariables['PI_RUNNER_STAGE_DIR'] = $stage
        $setup = [Diagnostics.Process]::Start($start)
        try {
            if (!$setup.WaitForExit(600000)) {
                Stop-UpdateProcess $setup
                throw 'Timed out staging the installer'
            }
            if ($setup.ExitCode -ne 0) { throw "Installer failed (exit code $($setup.ExitCode))" }
        } finally { $setup.Dispose() }
        $null = Get-UpdatedExecutable $stage
        if (!(Test-Path -LiteralPath (Join-Path $stage 'Uninstall.exe') -PathType Leaf)) { throw 'Staged uninstaller is missing' }
    }
    Move-UpdateDirectory $job.root $backup
    $restartRestoredApp = $false
    $switched = $false
    try {
        if (!$job.installer) { Assert-Inventory $backup $job.currentInventory }
        Move-UpdateDirectory $stage $job.root
        $switched = $true
        Start-UpdatedApp $job.root
    } catch {
        if ($switched) { Move-UpdateDirectory $job.root $stage }
        Move-UpdateDirectory $backup $job.root
        $restartRestoredApp = $true
        throw
    }
    if ($job.installer) {
        # Keep the previous installation: it may include files not managed by the installer.
        try {
            $registeredRoot = Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\PiRunner' -Name InstallDir
            if ($registeredRoot -eq $job.root) {
                Set-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PiRunner' -Name DisplayVersion -Value $job.version
            }
        } catch { }
    } else {
        try { Assert-Inventory $backup $job.currentInventory; Remove-Item -LiteralPath $backup -Recurse -Force } catch { }
    }
} catch {
    [IO.File]::WriteAllText((Join-Path $work 'error.txt'), $_.Exception.Message)
    if (Test-Path -LiteralPath $commit -PathType Leaf) {
        Add-Type -AssemblyName System.Windows.Forms
        if ($restartRestoredApp) {
            [void][Windows.Forms.MessageBox]::Show("The update could not be completed. The previous version is available and will open when you close this message.`n$_", 'Pi Runner')
            try {
                # The restored executable has the old version, so skip the new-version check.
                $restored = Start-AppProcess (Join-Path $job.root $job.exe) $job.root
                $restored.Dispose()
            } catch {
                [IO.File]::AppendAllText((Join-Path $work 'error.txt'), "`nCould not reopen previous version: $_")
                [void][Windows.Forms.MessageBox]::Show("Could not reopen the previous version. Open Pi Runner manually from $($job.root).`n$_", 'Pi Runner')
            }
        } else {
            [void][Windows.Forms.MessageBox]::Show("Update failed. Restart Pi Runner or update manually. Recovery directory: $work`n$_", 'Pi Runner')
        }
    }
    exit 1
}
foreach ($file in @('job.json', 'ready', 'commit', 'app-ready')) {
    $filePath = Join-Path $work $file
    if ([IO.File]::Exists($filePath)) { Remove-Item -LiteralPath $filePath -Force }
}
Remove-Item -LiteralPath $PSCommandPath -Force
if (!(Get-ChildItem -LiteralPath $work -Force)) { [IO.Directory]::Delete($work) }
