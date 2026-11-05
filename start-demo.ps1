param([int]$Port = 3210)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 24 或更高版本。' }
$env:PORT = [string]$Port
$env:HOST = '127.0.0.1'
node server.mjs --demo
