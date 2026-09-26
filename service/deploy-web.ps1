# Puts a new build of the web app live WITHOUT the usual ~30 s outage.
#
#   powershell -ExecutionPolicy Bypass -File deploy-web.ps1
#
# The live site runs from one build folder (.next or .next-b, named in web.conf).
# This builds into the OTHER one while the site keeps running, tries that build
# on port 3120 against the live backend, and only then points the service at it
# and restarts it - a few seconds. If the new build does not come up, the service
# goes straight back to the old one. The old build stays on disk until the next
# deploy, so going back is: swap the env.NEXT_DIST_DIR line in web.conf and
# Restart-Service SewingPlanningWeb.
#
# Needs no elevation: the installer gave this account start/stop rights on the service.

$ErrorActionPreference = 'Stop'
$svc = 'SewingPlanningWeb'
$conf = Join-Path $PSScriptRoot 'web.conf'
$web = (Resolve-Path (Join-Path $PSScriptRoot '..\frontend')).Path
$node = 'C:\Program Files\nodejs\node.exe'
$nextBin = Join-Path $web 'node_modules\next\dist\bin\next'

function Say($m, $c = 'Gray') { Write-Host ("{0:HH:mm:ss}  {1}" -f (Get-Date), $m) -ForegroundColor $c }
function Up($url, $seconds) {
    $until = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $until) {
        try { if ((Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { return $true } } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}
function SetDist($dir) {
    $lines = @(Get-Content $conf | Where-Object { $_ -notmatch '^env\.NEXT_DIST_DIR=' })
    $lines += "env.NEXT_DIST_DIR=$dir"
    Set-Content -Path $conf -Value $lines -Encoding ascii
}

$live = ((@(Get-Content $conf | Where-Object { $_ -match '^env\.NEXT_DIST_DIR=' }) -replace '^env\.NEXT_DIST_DIR=', '') -join '').Trim()
if (-not $live) { $live = '.next' }
$new = if ($live -eq '.next') { '.next-b' } else { '.next' }
Say "live build: $live - building the new one into $new while the site keeps running"

# next build rewrites these two files to point at the folder it builds into; put them back afterwards.
$keep = @{}
foreach ($f in 'next-env.d.ts', 'tsconfig.json') { $keep[$f] = [IO.File]::ReadAllText((Join-Path $web $f)) }

$target = Join-Path $web $new
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Push-Location $web
try {
    $env:NEXT_DIST_DIR = $new
    $env:NEXT_TELEMETRY_DISABLED = '1'
    & 'C:\Program Files\nodejs\npm.cmd' run build
    $built = $LASTEXITCODE -eq 0
} finally {
    Remove-Item Env:NEXT_DIST_DIR -ErrorAction SilentlyContinue
    Pop-Location
    foreach ($f in $keep.Keys) { [IO.File]::WriteAllText((Join-Path $web $f), $keep[$f]) }
}
if (-not $built) { Say 'BUILD FAILED - the live site was not touched.' Red; exit 1 }

# Try the new build on a spare port before the live site depends on it.
Say "trying $new on port 3120"
$psi = New-Object System.Diagnostics.ProcessStartInfo $node
$psi.Arguments = "`"$nextBin`" start -p 3120"
$psi.WorkingDirectory = $web
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['NODE_ENV'] = 'production'
$psi.EnvironmentVariables['NEXT_DIST_DIR'] = $new
$psi.EnvironmentVariables['NEXT_TELEMETRY_DISABLED'] = '1'
$trial = [System.Diagnostics.Process]::Start($psi)
try {
    $ok = (Up 'http://localhost:3120/login' 60) -and (Up 'http://localhost:3120/api/health' 10)
} finally {
    if (-not $trial.HasExited) { & taskkill /PID $trial.Id /T /F | Out-Null }
}
if (-not $ok) { Say "The new build did not come up on 3120 - the live site was not touched." Red; exit 1 }
Say 'new build answers on 3120' Green

# Switch: point the service at the new build and restart it.
SetDist $new
$t0 = Get-Date
Restart-Service $svc
if (Up 'http://localhost:3100/login' 60) {
    $down = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    Say "LIVE on $new - the site was restarting for about $down s" Green
    exit 0
}
Say "The service did not come back on $new - going back to $live" Red
SetDist $live
Restart-Service $svc
if (Up 'http://localhost:3100/login' 60) { Say "back on $live" Yellow } else { Say 'STILL DOWN - run fix-site.ps1' Red }
exit 1
