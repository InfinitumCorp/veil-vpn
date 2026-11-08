package com.infinitum.veilvpn

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Ikev2VpnProfile
import android.net.NetworkCapabilities
import android.net.VpnManager
import android.net.VpnProfileState
import android.os.Build
import androidx.annotation.RequiresApi
import org.json.JSONObject

/**
 * IKEv2/IPsec through Android's own VPN client (Android 11+): no extra code in the tunnel, the
 * system runs it. VEIL gives Android one profile (the node's host name, an EAP-MSCHAPv2 login from
 * the control server) and starts or stops it. The server certificate is checked against the
 * system's trusted CAs (the node uses a Let's Encrypt certificate for its host name).
 */
object Ikev2 {
    fun supported() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    @RequiresApi(Build.VERSION_CODES.R)
    private fun vm(ctx: Context) = ctx.getSystemService(VpnManager::class.java)

    @RequiresApi(Build.VERSION_CODES.R)
    private fun profile(j: JSONObject): Ikev2VpnProfile =
        Ikev2VpnProfile.Builder(j.getString("server"), j.getString("username"))
            .setAuthUsernamePassword(j.getString("username"), j.getString("password"), null)
            .setBypassable(false)
            .setMetered(false)
            .setMaxMtu(1360)
            .build()

    /**
     * Saves the profile. Returns Android's consent screen when the user has not yet allowed
     * VEIL to set up a VPN; null when it may start right away.
     */
    fun provision(ctx: Context, j: JSONObject): Intent? {
        if (!supported()) throw ApiError("ikev2_needs_android_11")
        return vm(ctx).provisionVpnProfile(profile(j))
    }

    fun start(ctx: Context) {
        if (!supported()) throw ApiError("ikev2_needs_android_11")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) vm(ctx).startProvisionedVpnProfileSession()
        else @Suppress("DEPRECATION") vm(ctx).startProvisionedVpnProfile()
    }

    fun stop(ctx: Context) {
        if (supported()) runCatching { vm(ctx).stopProvisionedVpnProfile() }
    }

    /** True once the IKEv2 session is up (Android 13+ reports it directly; older: a VPN network exists). */
    fun connected(ctx: Context): Boolean {
        if (!supported()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return vm(ctx).provisionedVpnProfileState?.state == VpnProfileState.STATE_CONNECTED
        }
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        @Suppress("DEPRECATION")
        return cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }
    }
}
