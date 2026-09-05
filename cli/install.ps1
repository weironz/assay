# Assay CLI installer. Usage: irm https://raw.githubusercontent.com/weironz/assay/main/cli/install.ps1 | iex
[CmdletBinding()]
param(
  [string]$InstallDir = $(Join-Path $HOME 'bin')
)

$ErrorActionPreference = 'Stop'
$Repo = 'weironz/assay'
$Releases = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers @{ 'User-Agent' = 'assay-installer' }
$Release = $Releases | Where-Object { $_.tag_name -like 'assay-cli-v*' -and -not $_.prerelease -and -not $_.draft } | Select-Object -First 1
if (-not $Release) { throw 'No stable assay-cli release found.' }

$AssetName = 'assay-x86_64-pc-windows-msvc.exe'
$Asset = $Release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
$Sums = $Release.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
if (-not $Asset -or -not $Sums) { throw "Release $($Release.tag_name) does not include a Windows package or checksums." }

$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("assay-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $TempDir | Out-Null
try {
  $Download = Join-Path $TempDir 'assay.exe'
  $SumFile = Join-Path $TempDir 'SHA256SUMS'
  Invoke-WebRequest $Asset.browser_download_url -OutFile $Download
  Invoke-WebRequest $Sums.browser_download_url -OutFile $SumFile
  $Expected = ((Get-Content $SumFile | Where-Object { $_ -match "\s$([regex]::Escape($AssetName))$" } | Select-Object -First 1) -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash $Download -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $Expected -or $Expected -ne $Actual) { throw 'SHA-256 verification failed; installation stopped.' }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Move-Item $Download (Join-Path $InstallDir 'assay.exe') -Force
} finally { Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue }

if ($env:Path -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable('Path', $env:Path + ";$InstallDir", 'User')
  Write-Host "Added $InstallDir to your user PATH. Open a new terminal before using assay."
}
Write-Host "Installed Assay CLI $($Release.tag_name) to $(Join-Path $InstallDir 'assay.exe')"
