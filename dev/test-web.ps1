# Test web app: port 3110, talks to the test backend on 4100, builds into .next-test (not the live .next).
$ErrorActionPreference = 'Stop'
$env:BACKEND_URL = 'http://localhost:4100'
$env:NEXT_DIST_DIR = '.next-test'
$env:NEXT_TELEMETRY_DISABLED = '1'
Set-Location (Join-Path $PSScriptRoot '..\frontend')
& 'C:\Program Files\nodejs\npx.cmd' next dev -p 3110
