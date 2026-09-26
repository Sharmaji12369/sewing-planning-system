# Copies the live database sewing_planning into sewing_planning_test (dropped and
# recreated). The live database is only read. Usage: powershell -File testdb.ps1 [-Drop]
param([switch]$Drop)
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\backend\.env'
$line = (Get-Content $envFile | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1) -replace '^\s*DATABASE_URL\s*=\s*', '' -replace '^"|"$', ''
$u = [Uri]$line
$user = [Uri]::UnescapeDataString($u.UserInfo.Split(':')[0])
$env:PGPASSWORD = [Uri]::UnescapeDataString($u.UserInfo.Split(':', 2)[1])
$bin = 'C:\Program Files\PostgreSQL\17\bin'
$common = @('-h', $u.Host, '-p', $u.Port, '-U', $user)
& "$bin\psql.exe" @common -d postgres -q -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS sewing_planning_test WITH (FORCE)'
if ($Drop) { 'test database dropped'; return }
& "$bin\psql.exe" @common -d postgres -q -v ON_ERROR_STOP=1 -c 'CREATE DATABASE sewing_planning_test'
$dump = Join-Path $env:TEMP 'sewing_planning_copy.sql'
& "$bin\pg_dump.exe" @common -d sewing_planning --no-owner -f $dump
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed' }
& "$bin\psql.exe" @common -d sewing_planning_test -q -v ON_ERROR_STOP=1 -f $dump | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'restore failed' }
Remove-Item $dump
'copied sewing_planning -> sewing_planning_test'
