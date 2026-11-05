<#
.SYNOPSIS
  Build a self-contained ProvianForegroundHelper.exe for development / CI.

.DESCRIPTION
  Windows counterpart of native/darwin/foreground-helper/build.sh. Publishes a
  single-file, self-contained win-x64 executable (no .NET runtime required on
  the target machine) into ./publish, then stages a copy into the SDK's
  bin/helpers/win32/ so the packaged tarball ships it and the postinstall
  script can copy it to ~/.provian/helpers/win32/.

  Authenticode signing (cert + timestamp) lives in the pre-beta release
  workflow, not here. This script is dev/CI build only.

.PARAMETER Debug
  Build Debug config instead of Release.

.EXAMPLE
  pwsh ./build.ps1
#>
param(
    [switch]$Debug
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$config = if ($Debug) { 'Debug' } else { 'Release' }
$publishDir = Join-Path $PSScriptRoot 'publish'

Write-Host "[helper] dotnet publish -c $config -r win-x64"
dotnet publish ProvianForegroundHelper.csproj `
    -c $config `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -o $publishDir

$exe = Join-Path $publishDir 'ProvianForegroundHelper.exe'
if (-not (Test-Path $exe)) {
    Write-Error "[helper] expected output not found at $exe"
    exit 1
}

# Stage into the SDK packaging dir (bin/helpers/win32) the postinstall reads.
# $PSScriptRoot = <sdk>/native/win32/foreground-helper
$sdkRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')
$binDir = Join-Path $sdkRoot 'bin/helpers/win32'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item -Force $exe (Join-Path $binDir 'ProvianForegroundHelper.exe')

Write-Host "[helper] built:  $exe"
Write-Host "[helper] staged: $(Join-Path $binDir 'ProvianForegroundHelper.exe')"
