# Methods called from JavaScript through the WebView bridge.
-keepclassmembers class com.infinitum.veilvpn.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
# WireGuard backend uses JNI.
-keep class com.wireguard.android.backend.** { *; }
# Amplitude Android SDK
-keep class com.amplitude.** { *; }
-dontwarn com.amplitude.**
