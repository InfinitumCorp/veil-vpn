# VEIL VPN Android release in one command: signed APK + AAB, checked, and (with -Publish) put on the site.
#
#   powershell -ExecutionPolicy Bypass -File scripts\release-android.ps1 `
#     -VersionCode 6 -VersionName 0.1.5 `
#     -AdmobAppId 'ca-app-pub-...~...' -AdmobBannerId 'ca-app-pub-.../...' -Publish
#
# Signing key: android/keystore/veil-upload.jks, alias veil-upload (override with VEIL_KEYSTORE / VEIL_KEY_ALIAS).
# Password: VEIL_KEYSTORE_PASSWORD (and VEIL_KEY_PASSWORD, same value for a PKCS12 key) if set, else read from
# the gitignored android/keystore.properties, otherwise asked for here without echoing. It is passed to Gradle only through this process's environment.
#
# -AllowTestAds builds with Google's sample ad IDs (a pipeline check only); it cannot be combined with -Publish.
# -Publish copies veil-vpn.apk to dist/site/download, rewrites SHA256SUMS.txt and deploys the site (cf deploy).
# The AAB for Google Play is left in android/app/build/outputs/bundle/release/ to upload by hand.
param(
  [Parameter(Mandatory)][int]$VersionCode,
  [Parameter(Mandatory)][string]$VersionName,
  [string]$AdmobAppId,
  [string]$AdmobBannerId,
  [string]$ControlUrl = 'https://api.infinitumveilvpn.app',
  [switch]$AllowTestAds,
  [switch]$Publish
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$android = Join-Path $root 'android'

if ($Publish -and $AllowTestAds) { throw '-Publish needs Infinitum''s own AdMob IDs, not -AllowTestAds' }
if (-not $AllowTestAds -and (-not $AdmobAppId -or -not $AdmobBannerId)) { throw 'Pass -AdmobAppId and -AdmobBannerId (VEIL VPN''s own AdMob app), or -AllowTestAds for a dry run' }
if ($AdmobAppId -and $AdmobAppId -notmatch '^ca-app-pub-\d{16}~\d{10}$') { throw 'AdmobAppId looks wrong (ca-app-pub-<16 digits>~<10 digits>)' }
if ($AdmobBannerId -and $AdmobBannerId -notmatch '^ca-app-pub-\d{16}/\d{10}$') { throw 'AdmobBannerId looks wrong (ca-app-pub-<16 digits>/<10 digits>)' }

# ---- toolchain
if (-not $env:JAVA_HOME) {
  $jdk = Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
  if (-not $jdk) { throw 'Set JAVA_HOME to a JDK 17 or 21' }
  $env:JAVA_HOME = $jdk.FullName
}
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path $env:ANDROID_HOME)) { throw "Android SDK not found at $env:ANDROID_HOME (set ANDROID_HOME)" }
$gradle = (Get-Command gradle -ErrorAction SilentlyContinue).Source
if (-not $gradle) {
  $want = ((Get-Content (Join-Path $android 'gradle\wrapper\gradle-wrapper.properties') | Select-String 'gradle-([\d.]+)-').Matches.Groups[1].Value)
  $gradle = Get-ChildItem (Join-Path $env:USERPROFILE '.gradle\wrapper\dists') -Recurse -Depth 4 -Filter gradle.bat -ErrorAction SilentlyContinue |
    Where-Object FullName -match "gradle-$([regex]::Escape($want))\\bin" | Select-Object -First 1 -ExpandProperty FullName
  if (-not $gradle) { throw "Gradle $want not found; install it or put gradle on PATH" }
}
$bt = Get-ChildItem (Join-Path $env:ANDROID_HOME 'build-tools') -Directory | Sort-Object { [version]($_.Name -replace '[^\d.]', '') } | Select-Object -Last 1
$apksigner = Join-Path $bt.FullName 'apksigner.bat'

# ---- signing key
if (-not $env:VEIL_KEYSTORE) { $env:VEIL_KEYSTORE = Join-Path $android 'keystore\veil-upload.jks' }
if (-not (Test-Path $env:VEIL_KEYSTORE)) { throw "No signing key at $env:VEIL_KEYSTORE" }
if (-not $env:VEIL_KEY_ALIAS) { $env:VEIL_KEY_ALIAS = 'veil-upload' }
$propsFile = Join-Path $android 'keystore.properties'
if (-not $env:VEIL_KEYSTORE_PASSWORD -and (Test-Path $propsFile)) {
  $m = Select-String -Path $propsFile -Pattern '^storePassword=(.+)$' | Select-Object -First 1
  if ($m) { $env:VEIL_KEYSTORE_PASSWORD = $m.Matches[0].Groups[1].Value.Trim() }
  $m = Select-String -Path $propsFile -Pattern '^keyPassword=(.+)$' | Select-Object -First 1
  if ($m -and -not $env:VEIL_KEY_PASSWORD) { $env:VEIL_KEY_PASSWORD = $m.Matches[0].Groups[1].Value.Trim() }
}
if (-not $env:VEIL_KEYSTORE_PASSWORD) {
  $sec = Read-Host -AsSecureString "Password for $(Split-Path -Leaf $env:VEIL_KEYSTORE)"
  $env:VEIL_KEYSTORE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if (-not $env:VEIL_KEY_PASSWORD) { $env:VEIL_KEY_PASSWORD = $env:VEIL_KEYSTORE_PASSWORD }

# ---- build (the web interface is copied into the app's assets first)
Push-Location $root
try { node scripts/build.mjs; if ($LASTEXITCODE) { throw 'npm run build failed' } } finally { Pop-Location }
$props = @("-PveilVersionCode=$VersionCode", "-PveilVersionName=$VersionName", "-PveilControlUrl=$ControlUrl")
if ($AllowTestAds) { $props += '-PveilAllowTestAds=true' } else { $props += "-PveilAdmobAppId=$AdmobAppId", "-PveilAdmobBannerId=$AdmobBannerId" }
Push-Location $android
try {
  & $gradle --console=plain -q clean assembleRelease bundleRelease @props
  if ($LASTEXITCODE) { throw "Gradle failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$apk = Join-Path $android 'app\build\outputs\apk\release\app-release.apk'
$aab = Join-Path $android 'app\build\outputs\bundle\release\app-release.aab'
foreach ($f in $apk, $aab) { if (-not (Test-Path $f)) { throw "Missing $f" } }

# ---- checks: signed with the release key (never the debug key), right version
$certs = & $apksigner verify --print-certs $apk 2>&1 | Out-String
if ($LASTEXITCODE) { throw "apksigner rejected the APK:`n$certs" }
if ($certs -match 'CN=Android Debug') { throw 'The APK is signed with the debug key' }
$aapt = Join-Path $bt.FullName 'aapt2.exe'
$badge = (& $aapt dump badging $apk 2>&1 | Select-String '^package:').Line
if ($badge -notmatch "versionCode='$VersionCode'" -or $badge -notmatch "versionName='$([regex]::Escape($VersionName))'") { throw "Unexpected version: $badge" }
Write-Host "Built and verified:`n  $apk`n  $aab`n  $badge"
Write-Host ($certs -split "`n" | Select-String 'certificate DN|SHA-256' | ForEach-Object { '  ' + $_.Line.Trim() } | Out-String)

if (-not $Publish) { Write-Host 'Not published (pass -Publish to put the APK on the site).'; return }

# ---- publish: the site's direct download, with checksums, then deploy the site
$out = Join-Path $root 'dist\site\download'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item $apk (Join-Path $out 'veil-vpn.apk') -Force
$zip = Join-Path $out 'veil-vpn-chrome.zip'
Remove-Item $zip -ErrorAction SilentlyContinue
Push-Location (Join-Path $root 'dist\extension'); try { & "$env:SystemRoot\System32\tar.exe" -a -cf $zip (Get-ChildItem -Name) } finally { Pop-Location }
Push-Location $root; try { node scripts/package-firefox.mjs; if ($LASTEXITCODE) { throw 'packaging failed' } } finally { Pop-Location }
Push-Location (Join-Path $root 'deploy\site'); try { cf deploy; if ($LASTEXITCODE) { throw 'site deploy failed' } } finally { Pop-Location }
$live = Invoke-WebRequest 'https://infinitumveilvpn.app/download/SHA256SUMS.txt' -UseBasicParsing
Write-Host "Published. Live checksums:`n$($live.Content)"
