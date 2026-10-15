# Copy a colony's backups to this Windows PC: the off-site copy, pulled over SSH (the OpenSSH client built into
# Windows 10 and 11) from a host whose key for this PC can only run deploy/backup-serve.sh. Copies the archives it
# does not have yet, checks each one is a readable archive before keeping it, and deletes local copies older than
# -KeepDays (default 60).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File pull-backups.ps1 -SshHost myrmo-backups
#
# -SshHost is a host or alias from %USERPROFILE%\.ssh\config (with its user and key). To run it every day, and
# as soon as the PC is on again after a missed day (it catches up as long as it runs within the colony's retention,
# 14 days by default), register a scheduled task once:
#
#   $action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\myrmo\pull-backups.ps1" -SshHost myrmo-backups'
#   $trigger = New-ScheduledTaskTrigger -Daily -At 10:00
#   $options = New-ScheduledTaskSettingsSet -StartWhenAvailable
#   Register-ScheduledTask -TaskName "Myrmo backups" -Action $action -Trigger $trigger -Settings $options
param(
    [Parameter(Mandatory = $true)][string]$SshHost,
    [string]$Dest = (Join-Path $HOME "myrmo-backups-copy"),
    [int]$KeepDays = 60
)
$ErrorActionPreference = "Stop"
$name = '^myrmo-\d{8}T\d{6}Z\.tar\.gz$'
$log = Join-Path $Dest "pull.log"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
function Write-Log([string]$text) { "$(Get-Date -Format s) $text" | Tee-Object -FilePath $log -Append }

$names = & ssh -o BatchMode=yes $SshHost list
if ($LASTEXITCODE -ne 0) { Write-Log "ERROR: could not list the backups on $SshHost (ssh exit $LASTEXITCODE)"; exit 1 }

$copied = 0
foreach ($archive in $names) {
    if ($archive -notmatch $name) { continue }
    $target = Join-Path $Dest $archive
    if (Test-Path $target) { continue }
    $partial = "$target.partial"
    # cmd.exe redirects the raw bytes; PowerShell's own > would re-encode the stream and damage the archive.
    cmd.exe /c "ssh -o BatchMode=yes $SshHost get $archive > `"$partial`""
    & tar.exe -tzf $partial *> $null
    if ($LASTEXITCODE -eq 0) {
        Move-Item -Force $partial $target
        $copied++
    } else {
        Remove-Item -Force $partial -ErrorAction SilentlyContinue
        Write-Log "WARNING: $archive arrived damaged; it will be tried again next run"
    }
}
Get-ChildItem -Path $Dest -Filter "myrmo-*.tar.gz" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
    Remove-Item -Force
$kept = (Get-ChildItem -Path $Dest -Filter "myrmo-*.tar.gz").Count
Write-Log "copied $copied new archive(s); $kept kept in $Dest"
