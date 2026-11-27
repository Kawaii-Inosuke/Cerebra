# Builds the Microsoft Store package (MSIX) from Cerebra's Windows .msi.
#
#   pwsh packaging/msix/build-msix.ps1 -Msi Cerebra_0.1.0_x64_en-US.msi -Version 0.1.0 -Out dist
#
# Unpacks the .msi without installing it, adds AppxManifest.xml and the Store icons, and packs the
# folder with makeappx from the Windows SDK. The result is unsigned on purpose: the Microsoft Store
# signs it after certification. (An unsigned .msix can't be installed by double-clicking; it's only
# for uploading to Partner Center.)
param(
  [Parameter(Mandatory = $true)][string]$Msi,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Out = "dist"
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.2.3 (got '$Version')" }

$work = Join-Path ([IO.Path]::GetTempPath()) ("cerebra-msix-" + [Guid]::NewGuid())
$extract = Join-Path $work "msi"
$layout = Join-Path $work "layout"
New-Item -ItemType Directory -Force -Path $extract, $layout, $Out | Out-Null

# 1. Unpack the .msi (an "administrative install" only copies its files).
$msiFull = (Resolve-Path $Msi).Path
$p = Start-Process msiexec.exe -ArgumentList @("/a", "`"$msiFull`"", "/qn", "TARGETDIR=`"$extract`"") -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "msiexec /a failed with exit code $($p.ExitCode)" }

# 2. Find the app folder: the one holding the main program (not the agents helper, not an uninstaller).
$exe = Get-ChildItem -Path $extract -Recurse -Filter *.exe |
  Where-Object { $_.Name -notmatch '^(cerebra-agents|uninstall)' } |
  Sort-Object Length -Descending | Select-Object -First 1
if (-not $exe) { throw "No program found inside the .msi" }
$appDir = $exe.DirectoryName
Write-Host "Main program: $($exe.Name) in $appDir"
if (-not (Test-Path (Join-Path $appDir "cerebra-agents.exe"))) { throw "cerebra-agents.exe is missing next to $($exe.Name)" }

Copy-Item -Path (Join-Path $appDir "*") -Destination $layout -Recurse -Force

# 3. Manifest (version and program name filled in) and icons.
$manifest = Get-Content (Join-Path $here "AppxManifest.xml") -Raw
$manifest = $manifest.Replace("__VERSION__", $Version).Replace("__EXE__", $exe.Name)
[IO.File]::WriteAllText((Join-Path $layout "AppxManifest.xml"), $manifest, (New-Object Text.UTF8Encoding $false))
New-Item -ItemType Directory -Force -Path (Join-Path $layout "Assets") | Out-Null
Copy-Item -Path (Join-Path $here "Assets\*") -Destination (Join-Path $layout "Assets") -Force

# 4. Pack with the newest makeappx in the Windows SDK.
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw "makeappx.exe not found (Windows SDK missing)" }
$target = Join-Path (Resolve-Path $Out).Path "Cerebra_${Version}_x64.msix"
& $makeappx.FullName pack /d $layout /p $target /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }

Remove-Item -Recurse -Force $work
Write-Host "Built $target"
