package com.infinitum.veilvpn

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import android.provider.Settings
import android.util.Base64
import java.io.File
import java.security.MessageDigest

/**
 * Device signals for fraud protection. The server stores only a keyed hash of [id]; nothing here
 * identifies the person. These checks are a first line only: for production, add Google Play
 * Integrity (needs a Google Cloud project and server-side verification).
 */
object DeviceCheck {
    /** Stable per app and device (ANDROID_ID is scoped to this app's signing key), hashed again here. */
    @SuppressLint("HardwareIds")
    fun id(ctx: Context): String {
        val raw = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
        val d = MessageDigest.getInstance("SHA-256").digest("veil:${ctx.packageName}:$raw".toByteArray())
        return Base64.encodeToString(d, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    fun emulator(): Boolean =
        Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.contains("emulator") ||
        Build.HARDWARE.contains("goldfish") || Build.HARDWARE.contains("ranchu") ||
        Build.PRODUCT.contains("sdk") || Build.MODEL.contains("Emulator") || Build.MODEL.contains("Android SDK built for")

    fun rooted(): Boolean =
        Build.TAGS?.contains("test-keys") == true ||
        listOf("/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/app/Superuser.apk", "/data/adb/magisk").any { File(it).exists() }

    /** Comma list for the x-veil-integrity header, empty when nothing is found. */
    fun integrity(ctx: Context): String = listOfNotNull(
        "emulator".takeIf { emulator() },
        "rooted".takeIf { rooted() },
        "debuggable".takeIf { ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 },
    ).joinToString(",")
}
