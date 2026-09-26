<#
  Brings the Sewing Planning site back when it is down. It checks each piece
  in turn and restarts only the one that is not working:

      internet -> database -> API -> web app -> Cloudflare tunnel -> public site

  Run it in PowerShell. It asks for administrator rights by itself (click Yes):

    powershell -ExecutionPolicy Bypass -File "C:\path\to\SewingPlanningSystem\service\fix-site.ps1"

  Only look, change nothing:

    powershell -ExecutionPolicy Bypass -File "C:\path\to\SewingPlanningSystem\service\fix-site.ps1" -CheckOnly

  If the laptop was asleep, hibernated or switched off, open it / switch it on
  first - nothing can run on it until it is awake. Everything normally comes
  back by itself within a minute or two after that; this is for when it does not.
#>
param([switch]$CheckOnly)

$PUBLIC = 'https://sewing-planning.example.com/api/health'
$API    = 'http://localhost:4000/api/health'
$WEB    = 'http://localhost:3100/api/health'
$LOGS   = Join-Path $PSScriptRoot 'logs'

# --- administrator rights: the database and the tunnel need them to restart -------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $CheckOnly -and -not $admin) {
    Write-Host 'Asking for administrator rights - click Yes on the prompt...' -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    return
}

$fixed = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]

function Say($state, $what, $detail = '') {
    $colour = @{ 'OK' = 'Green'; 'FIXED' = 'Green'; 'DOWN' = 'Red'; 'FAIL' = 'Red'; 'WOULD' = 'Yellow'; 'WAIT' = 'DarkGray'; 'NOTE' = 'Yellow' }[$state]
    Write-Host ('  [{0,-5}] ' -f $state) -ForegroundColor $colour -NoNewline
    Write-Host $what -NoNewline
    if ($detail) { Write-Host "  - $detail" -ForegroundColor DarkGray } else { Write-Host '' }
}

# "ok":true from a health URL. The API also says whether the database answered.
function Test-Health($url, $seconds = 8) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $seconds
        return @{ up = ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true'); db = ($r.Content -match '"db"\s*:\s*true') }
    } catch {
        return @{ up = $false; db = $false }
    }
}

function Wait-Health($url, $seconds) {
    $until = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $until) {
        if ((Test-Health $url 5).up) { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Wait-Running($name, $seconds = 30) {
    $until = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $until) {
        if ((Get-Service $name -ErrorAction SilentlyContinue).Status -eq 'Running') { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

<#
  One service: installed? running? and, when it has a health URL, answering?
  Starts it if stopped, restarts it if running but not answering.
#>
function Repair($name, $label, $url = $null, $waitSeconds = 60) {
    $svc = Get-Service $name -ErrorAction SilentlyContinue
    if (-not $svc) {
        Say 'FAIL' $label "the Windows service '$name' is not installed"
        $failed.Add("$label is not installed (run service\install-services.ps1 as administrator)")
        return $false
    }
    $running = $svc.Status -eq 'Running'
    $answering = if ($url -and $running) { (Test-Health $url).up } else { $running }
    if ($running -and $answering) { Say 'OK' $label; return $true }

    $problem = if (-not $running) { "service is $($svc.Status.ToString().ToLower())" } else { 'running but not answering' }
    if ($CheckOnly) { Say 'WOULD' $label "$problem - would $(if ($running) { 'restart' } else { 'start' }) it"; return $false }

    Say 'WAIT' $label "$problem - $(if ($running) { 'restarting' } else { 'starting' })..."
    try {
        if ($running) { Restart-Service $name -Force -ErrorAction Stop } else { Start-Service $name -ErrorAction Stop }
    } catch {
        Say 'FAIL' $label $_.Exception.Message
        $failed.Add("$label would not start: $($_.Exception.Message)")
        return $false
    }
    $ok = (Wait-Running $name) -and ((-not $url) -or (Wait-Health $url $waitSeconds))
    if ($ok) { Say 'FIXED' $label; $fixed.Add($label) } else {
        Say 'FAIL' $label 'still not answering'
        $failed.Add("$label is still not answering after a restart")
    }
    return $ok
}

Write-Host ''
Write-Host "Sewing Planning - site check  $(Get-Date -Format 'dd MMM yyyy HH:mm')$(if ($CheckOnly) { '  (check only - nothing will be changed)' })" -ForegroundColor Cyan
Write-Host ''

# 1. Internet. Without it the site cannot be reached from outside whatever else is done.
#    (A real request, not a DNS lookup - a cached lookup answers even with the Wi-Fi off.)
$online = $false
try { $online = (Invoke-WebRequest -Uri 'https://www.cloudflare.com/cdn-cgi/trace' -UseBasicParsing -TimeoutSec 8).StatusCode -eq 200 } catch {}
if ($online) { Say 'OK' 'Internet' } else {
    Say 'DOWN' 'Internet' 'no connection - connect the Wi-Fi first; the steps below still run'
    $failed.Add('No internet: connect the Wi-Fi, then run this again')
}

# 2-4. The database, the API behind it, and the web app in front of it - in that order.
[void](Repair 'postgresql-x64-17' 'Database (PostgreSQL)')
$apiOk = Repair 'SewingPlanningAPI' 'API' $API
if ($apiOk -and -not (Test-Health $API).db) {
    # The API is up but cannot reach the database: restart the database, then the API.
    if ($CheckOnly) { Say 'WOULD' 'Database' 'API cannot reach it - would restart the database and the API' } else {
        Say 'WAIT' 'Database' 'the API cannot reach it - restarting both...'
        Restart-Service 'postgresql-x64-17' -Force -ErrorAction SilentlyContinue
        [void](Wait-Running 'postgresql-x64-17')
        Restart-Service 'SewingPlanningAPI' -Force -ErrorAction SilentlyContinue
        if ((Wait-Health $API 60) -and (Test-Health $API).db) { Say 'FIXED' 'Database'; $fixed.Add('Database') }
        else { Say 'FAIL' 'Database' 'the API still cannot reach it'; $failed.Add('The API cannot reach the database') }
    }
}
[void](Repair 'SewingPlanningWeb' 'Web app' $WEB 90)

# 5. The tunnel. Only worth touching once the site works on this laptop itself -
#    then "works here, not from outside" can only be the tunnel.
$localOk = (Test-Health $WEB).up
$publicOk = $online -and (Test-Health $PUBLIC 12).up
$tunnel = Get-Service 'Cloudflared' -ErrorAction SilentlyContinue
if ($publicOk) { Say 'OK' 'Cloudflare tunnel' }
elseif (-not $tunnel) { Say 'FAIL' 'Cloudflare tunnel' "the Windows service 'Cloudflared' is not installed"; $failed.Add('The Cloudflare tunnel service is not installed') }
elseif (-not $localOk) { Say 'NOTE' 'Cloudflare tunnel' 'skipped - the site is not working on this laptop yet' }
elseif (-not $online) { Say 'NOTE' 'Cloudflare tunnel' 'skipped - no internet' }
elseif ($CheckOnly) { Say 'WOULD' 'Cloudflare tunnel' "works here but not from outside - would $(if ($tunnel.Status -eq 'Running') { 'restart' } else { 'start' }) the tunnel" }
else {
    Say 'WAIT' 'Cloudflare tunnel' 'the site works here but not from outside - restarting the tunnel...'
    try {
        if ($tunnel.Status -eq 'Running') { Restart-Service 'Cloudflared' -Force -ErrorAction Stop } else { Start-Service 'Cloudflared' -ErrorAction Stop }
        if (Wait-Health $PUBLIC 90) { Say 'FIXED' 'Cloudflare tunnel'; $fixed.Add('Cloudflare tunnel') }
        else { Say 'FAIL' 'Cloudflare tunnel' 'public site still not answering'; $failed.Add('The site works on this laptop but not from outside') }
    } catch {
        Say 'FAIL' 'Cloudflare tunnel' $_.Exception.Message
        $failed.Add("The tunnel would not restart: $($_.Exception.Message)")
    }
}

# 6. The answer that matters.
Write-Host ''
$final = $online -and (Test-Health $PUBLIC 12).up
if ($final) {
    Write-Host '  THE SITE IS UP  -  https://sewing-planning.example.com' -ForegroundColor Green
    if ($fixed.Count) { Write-Host "  Fixed: $($fixed -join ', ')" -ForegroundColor Green }
    elseif (-not $CheckOnly) { Write-Host '  Nothing needed fixing. If a browser still shows an error, refresh it (Ctrl+Shift+R).' }
} else {
    Write-Host '  THE SITE IS STILL DOWN' -ForegroundColor Red
    foreach ($f in $failed) { Write-Host "  - $f" -ForegroundColor Red }
    if (-not $CheckOnly) {
        Write-Host ''
        Write-Host '  Last lines of the logs (send a screenshot of this window if it stays down):' -ForegroundColor Yellow
        foreach ($log in 'api.log', 'web.log') {
            $p = Join-Path $LOGS $log
            if (Test-Path $p) {
                Write-Host "  --- $log" -ForegroundColor DarkGray
                Get-Content $p -Tail 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            }
        }
    }
}
Write-Host ''
