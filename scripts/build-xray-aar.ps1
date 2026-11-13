# Builds android/app/libs/veilxray.aar: Xray-core (VLESS Reality and the HTTPS-proxy tunnel) for the Android app.
# The AAR is a build output (gitignored); release-android.ps1 runs this when it is missing.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-xray-aar.ps1
#
# Needs Go (1.25+), the Android SDK with an NDK, and gomobile:
#   go install golang.org/x/mobile/cmd/gomobile@latest; go install golang.org/x/mobile/cmd/gobind@latest
# Xray-core's version is pinned in android/xray/go.mod (keep it in step with XRAY_VERSION in shared/proxyproto.js).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'android\xray'
$out = Join-Path $root 'android\app\libs\veilxray.aar'

if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not $env:ANDROID_NDK_HOME) {
  $ndk = Get-ChildItem (Join-Path $env:ANDROID_HOME 'ndk') -Directory -ErrorAction SilentlyContinue | Sort-Object { [version]$_.Name } | Select-Object -Last 1
  if (-not $ndk) { throw "No NDK under $env:ANDROID_HOME\ndk (install one with sdkmanager 'ndk;28.2.13676358')" }
  $env:ANDROID_NDK_HOME = $ndk.FullName
}
$gobin = Join-Path (go env GOPATH) 'bin'
$env:PATH = "$gobin;$env:PATH"
if (-not (Get-Command gomobile -ErrorAction SilentlyContinue)) { throw 'gomobile not found: go install golang.org/x/mobile/cmd/gomobile@latest' }

New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
Push-Location $src
try {
  # -checklinkname=0: Xray's network-interface helper (wlynxg/anet) links to a Go runtime internal, as in Xray's own builds.
  & gomobile bind -target 'android/arm64,android/arm' -androidapi 26 -javapkg com.infinitum.veilvpn.xray `
    -trimpath -ldflags '-checklinkname=0 -s -w -buildid=' -o $out .
  if ($LASTEXITCODE -ne 0) { throw "gomobile bind failed ($LASTEXITCODE)" }
} finally { Pop-Location }
Get-Item $out | Select-Object Name, Length
