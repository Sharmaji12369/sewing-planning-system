<#
  Keeps this laptop awake so the Sewing Planning site stays up while it has a
  network connection. Run it in PowerShell opened with "Run as administrator":

    powershell -ExecutionPolicy Bypass -File "C:\path\to\SewingPlanningSystem\service\keep-awake.ps1"

  Plugged in and on battery alike:
    - never sleeps when idle
    - the screen never turns itself off - dim it instead (see below) - not
      even on the lock screen, so Windows + L is safe to use
    - closing the lid does nothing
    - the power and sleep buttons do nothing (holding the power button for
      4+ seconds still forces it off - that is the hardware, not Windows)
    - Wi-Fi at full power, and it stays connected even if the laptop does go
      into standby
    - hibernation is switched off; at 2% battery it shuts down instead

  Why the screen and the power button matter here (24 Sep 2026): this laptop
  has no ordinary sleep mode, only "Modern Standby", and it enters that
  whenever the screen turns off - after 15 minutes idle, or a press of the
  power button. On battery, Windows then decided standby was using too much
  battery and hibernated it ("Standby Battery Budget Exceeded"), which took
  the site down from 10:25 PM on 23 Sep until the laptop was opened at 9:33 AM.
  Keeping the screen on stops it entering standby at all; hibernation off
  means it can never be switched off that way again.

  With the lid closed it keeps running - shut it down before putting it in a bag.
  Best of all: leave it plugged in. On battery it will run until it is flat.

  To put back the settings this laptop had before (22 Sep 2026):

    powershell -ExecutionPolicy Bypass -File "...\service\keep-awake.ps1" -Undo
#>
param([switch]$Undo)

$ErrorActionPreference = 'Stop'

# powercfg values. Actions: 0 do nothing, 1 sleep, 2 hibernate, 3 shut down, 4 turn off the display.
$WIFI = '19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a'   # 0 = maximum performance
# Networking connectivity in Standby: 0 disabled, 1 enabled, 2 managed by Windows.
$STANDBYNET = 'fea3413e-7e05-4911-9a71-700331f1c294 f15576e8-98b7-4186-b944-eafa664402d9'
# Console lock display off timeout (seconds): how soon the screen goes dark after Windows + L.
$LOCKSCREEN = '7516b95f-f776-4464-8c53-06167f40cc99 8ec4b3a5-6868-48c2-be75-4f3044be88a7'
if ($Undo) {
    $plan = @(
        @('SUB_SLEEP STANDBYIDLE', 900, 900, 'Sleep when idle (seconds)'),
        @('SUB_VIDEO VIDEOIDLE', 900, 900, 'Screen turns off'),
        @($LOCKSCREEN, 30, 30, 'Screen off when locked'),
        @('SUB_BUTTONS LIDACTION', 1, 1, 'Closing the lid'),
        @('SUB_BUTTONS PBUTTONACTION', 1, 1, 'Power button'),
        @('SUB_BUTTONS SBUTTONACTION', 1, 1, 'Sleep button'),
        @('SUB_BATTERY BATACTIONCRIT', 2, 2, 'At critical battery'),
        @($WIFI, 0, 2, 'Wi-Fi power saving'),
        @($STANDBYNET, 1, 2, 'Wi-Fi in standby')
    )
} else {
    $plan = @(
        @('SUB_SLEEP STANDBYIDLE', 0, 0, 'Sleep when idle (0 = never)'),
        @('SUB_VIDEO VIDEOIDLE', 0, 0, 'Screen turns off'),
        @($LOCKSCREEN, 0, 0, 'Screen off when locked'),
        @('SUB_BUTTONS LIDACTION', 0, 0, 'Closing the lid'),
        @('SUB_BUTTONS PBUTTONACTION', 0, 0, 'Power button'),
        @('SUB_BUTTONS SBUTTONACTION', 0, 0, 'Sleep button'),
        @('SUB_BATTERY BATACTIONCRIT', 3, 3, 'At critical battery'),
        @($WIFI, 0, 0, 'Wi-Fi power saving'),
        @($STANDBYNET, 1, 1, 'Wi-Fi in standby')
    )
}

$names = @{ 0 = 'do nothing'; 1 = 'sleep'; 2 = 'hibernate'; 3 = 'shut down'; 4 = 'turn off the screen' }
function Describe($setting, $value) {
    if ($setting -like '*STANDBYIDLE' -or $setting -like '*VIDEOIDLE') {
        if ($value -eq 0) { return 'never' } return "after $($value / 60) min"
    }
    if ($setting -eq $LOCKSCREEN) { if ($value -eq 0) { return 'never' } return "after $value s" }
    if ($setting -eq $WIFI) { if ($value -eq 0) { return 'off (full power)' } return "power saving level $value" }
    if ($setting -eq $STANDBYNET) { return @{ 0 = 'disconnected'; 1 = 'stays connected'; 2 = 'up to Windows' }[[int]$value] }
    return $names[[int]$value]
}

Write-Host ''
Write-Host ('{0,-28} {1,-22} {2}' -f 'Setting', 'Plugged in', 'On battery') -ForegroundColor Cyan
foreach ($p in $plan) {
    $ids = $p[0] -split ' '
    & powercfg /setacvalueindex SCHEME_CURRENT $ids[0] $ids[1] $p[1]
    if ($LASTEXITCODE -ne 0) { throw "powercfg could not set $($p[3]) (plugged in)" }
    & powercfg /setdcvalueindex SCHEME_CURRENT $ids[0] $ids[1] $p[2]
    if ($LASTEXITCODE -ne 0) { throw "powercfg could not set $($p[3]) (on battery)" }
    Write-Host ('{0,-28} {1,-22} {2}' -f $p[3], (Describe $p[0] $p[1]), (Describe $p[0] $p[2]))
}
& powercfg /setactive SCHEME_CURRENT
if ($LASTEXITCODE -ne 0) { throw 'powercfg could not apply the settings' }

# Hibernation off: nothing can put the laptop into it, including the standby
# battery budget that switched it off overnight on 23 Sep. (This also turns off
# Fast Startup, so a restart is a true restart - no harm for a machine that
# should stay on.)
& powercfg /hibernate $(if ($Undo) { 'on' } else { 'off' })
if ($LASTEXITCODE -ne 0) { throw 'powercfg could not change hibernation' }
Write-Host ('{0,-28} {1}' -f 'Hibernation', $(if ($Undo) { 'on' } else { 'off' }))
Write-Host "`nSaved and applied." -ForegroundColor Green

# After a restart the site is only reachable once Wi-Fi connects. A network that
# signs in with a user's own Windows account (802.1X / Enterprise) connects only
# after someone signs in, so say so.
if (-not $Undo) {
    $wlan = @(& netsh wlan show interfaces)
    $auth = ($wlan | Select-String '^\s*Authentication\s*:' | Select-Object -First 1).Line -replace '^.*:\s*', ''
    $ssid = ($wlan | Select-String '^\s*SSID\s*:' | Select-Object -First 1).Line -replace '^.*:\s*', ''
    if ($ssid) {
        Write-Host "`nWi-Fi: $ssid ($auth)"
        if ($auth -match 'Enterprise|802\.1X') {
            Write-Host 'This network signs in with a Windows account, so after a restart it may connect only once someone signs in to the laptop. Sign in after every restart, or ask IT for a network that connects before sign-in.' -ForegroundColor Yellow
        } else {
            Write-Host 'This network connects by itself at start-up, before anyone signs in.'
        }
    }
    Write-Host "`nThe screen now stays on. Turn the brightness right down (Fn + brightness key) to save it." -ForegroundColor Yellow
}
