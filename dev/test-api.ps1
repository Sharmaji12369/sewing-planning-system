# Test backend: port 4100, database sewing_planning_test (a copy), reloads on edits.
$ErrorActionPreference = 'Stop'
$backend = (Resolve-Path (Join-Path $PSScriptRoot '..\backend')).Path
$line = (Get-Content "$backend\.env" | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1) -replace '^\s*DATABASE_URL\s*=\s*', '' -replace '^"|"$', ''
$env:DATABASE_URL = $line -replace '/sewing_planning(\?|$)', '/sewing_planning_test$1'
if ($env:DATABASE_URL -notmatch '/sewing_planning_test') { throw 'could not point at the test database' }
$env:PORT = '4100'
Set-Location $backend
& 'C:\Program Files\nodejs\npm.cmd' run dev
