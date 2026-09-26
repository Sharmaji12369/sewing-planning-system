<#
  Installs the Sewing Planning System as two Windows services, so the site runs
  whenever this PC is on - nobody needs to be signed in:

    SewingPlanningAPI   backend, port 4000   (starts after PostgreSQL)
    SewingPlanningWeb   web app, port 3100   (what the Cloudflare tunnel serves)

  Run it ONCE, in PowerShell opened with "Run as administrator":

    powershell -ExecutionPolicy Bypass -File "C:\path\to\SewingPlanningSystem\service\install-services.ps1"

  Safe to run again: it replaces the services. To take them off:

    powershell -ExecutionPolicy Bypass -File "...\service\install-services.ps1" -Uninstall
#>
#Requires -RunAsAdministrator
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$hostExe = Join-Path $here 'SewingHost.exe'
$node = 'C:\Program Files\nodejs\node.exe'

# The Windows account that may start, stop and restart these two services from a
# normal (not administrator) window, so updates can be applied without elevation:
# the account that runs the installer. It gets no other rights.
$operatorSid = 'S-1-5-21-1829619307-76279704-1181997009-3138'

$services = @(
    [pscustomobject]@{
        Name = 'SewingPlanningAPI'; Display = 'Sewing Planning - API'; Conf = 'api.conf'; Log = 'logs\api.log'
        Port = 4000; Url = 'http://localhost:4000/api/health'; DependsOn = @('postgresql-x64-17')
        Description = 'Sewing Planning System backend (Node.js, port 4000) on the sewing_planning PostgreSQL database.'
    },
    [pscustomobject]@{
        Name = 'SewingPlanningWeb'; Display = 'Sewing Planning - Web'; Conf = 'web.conf'; Log = 'logs\web.log'
        Port = 3100; Url = 'http://localhost:3100/login'; DependsOn = @()
        Description = 'Sewing Planning System web app (Next.js, port 3100), served publicly by the Cloudflare tunnel.'
    }
)

function Step([string]$text) { Write-Host "`n== $text" -ForegroundColor Cyan }

function Invoke-Sc {
    $out = & sc.exe @args
    if ($LASTEXITCODE -ne 0) { throw "sc.exe $($args -join ' ') failed: $($out -join ' ')" }
}

Step 'Removing any earlier copy of the services'
foreach ($s in $services) {
    if (-not (Get-Service $s.Name -ErrorAction SilentlyContinue)) { continue }
    Stop-Service $s.Name -Force -ErrorAction SilentlyContinue
    Invoke-Sc delete $s.Name
    for ($i = 0; $i -lt 20 -and (Get-Service $s.Name -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    if (Get-Service $s.Name -ErrorAction SilentlyContinue) {
        throw "$($s.Name) is marked for removal but Windows is still holding it. Close the Services window (services.msc) and run this again."
    }
    Write-Host "removed $($s.Name)"
}

if ($Uninstall) {
    Write-Host "`nBoth services are removed. The site is down until they are installed again." -ForegroundColor Yellow
    return
}

Step 'Checking what the services need'
if (-not (Test-Path $node)) { throw "Node.js is not at $node" }
if (-not (Get-Service 'postgresql-x64-17' -ErrorAction SilentlyContinue)) { throw 'The PostgreSQL service postgresql-x64-17 is not installed.' }
if (-not (Test-Path (Join-Path $here '..\backend\.env'))) { throw 'backend\.env is missing.' }
if (-not (Test-Path (Join-Path $here '..\frontend\.next\BUILD_ID'))) { throw 'The web app has not been built. Run: cd frontend; npm.cmd run build' }
Write-Host 'Node.js, PostgreSQL, backend\.env and the web build are all there.'

Step 'Building the service host (SewingHost.exe)'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:exe /platform:anycpu "/out:$hostExe" /reference:System.ServiceProcess.dll (Join-Path $here 'SewingHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Compiling SewingHost.cs failed (see above).' }
Write-Host "built $hostExe"

Step 'Freeing ports 4000 and 3100 (copies started by hand for development)'
foreach ($s in $services) {
    $owners = Get-NetTCPConnection -LocalPort $s.Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($id in $owners) {
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if (-not $p) { continue }
        if ($p.ProcessName -ne 'node') {
            throw "Port $($s.Port) is held by $($p.ProcessName) (pid $id), which is not Node. Close it and run this again."
        }
        Stop-Process -Id $id -Force
        Write-Host "stopped node (pid $id) on port $($s.Port)"
    }
}
Start-Sleep -Seconds 1

Step 'Installing the services'
foreach ($s in $services) {
    $params = @{
        Name           = $s.Name
        BinaryPathName = "`"$hostExe`" `"$(Join-Path $here $s.Conf)`""
        DisplayName    = $s.Display
        Description    = $s.Description
        StartupType    = 'Automatic'
    }
    if ($s.DependsOn.Count) { $params.DependsOn = $s.DependsOn }
    New-Service @params | Out-Null

    # The host restarts Node by itself; this restarts the host if it ever dies.
    Invoke-Sc failure $s.Name reset= 86400 actions= restart/5000/restart/15000/restart/60000

    # Start / stop / restart for the operator account (see $operatorSid above).
    $sd = ((& sc.exe sdshow $s.Name) -join '').Trim()
    if ($sd -notlike "*$operatorSid*") {
        Invoke-Sc sdset $s.Name ($sd -replace '^D:', "D:(A;;CCLCSWRPWPDTLOCRRC;;;$operatorSid)")
    }
    Write-Host "installed $($s.Name)  ($($s.Display), starts automatically with Windows)"
}

Step 'Starting'
foreach ($s in $services) {
    Start-Service $s.Name
    Write-Host "started $($s.Name)"
}

Step 'Checking they answer'
$allOk = $true
foreach ($s in $services) {
    $up = $false
    for ($i = 0; $i -lt 60 -and -not $up; $i++) {
        try {
            $r = Invoke-WebRequest $s.Url -UseBasicParsing -TimeoutSec 5
            $up = $r.StatusCode -eq 200
        } catch { Start-Sleep -Seconds 1 }
    }
    if ($up) {
        Write-Host "OK    $($s.Name)   $($s.Url)" -ForegroundColor Green
    } else {
        $allOk = $false
        Write-Host "FAIL  $($s.Name) did not answer on $($s.Url). Last lines of its log:" -ForegroundColor Red
        Get-Content (Join-Path $here $s.Log) -Encoding UTF8 -Tail 25 -ErrorAction SilentlyContinue
    }
}

try {
    $r = Invoke-WebRequest 'https://sewing-planning.example.com/api/health' -UseBasicParsing -TimeoutSec 20
    Write-Host "OK    public site   https://sewing-planning.example.com  ($($r.Content))" -ForegroundColor Green
} catch {
    Write-Host "WARN  the public address did not answer yet: $($_.Exception.Message)" -ForegroundColor Yellow
}

if ($allOk) {
    Write-Host "`nDone. Both services start with Windows and restart themselves if they stop." -ForegroundColor Green
    Write-Host "Logs: $(Join-Path $here 'logs')"
} else {
    Write-Host "`nSomething did not start - the messages above say which step failed." -ForegroundColor Red
    exit 1
}
