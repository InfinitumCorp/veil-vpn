package com.infinitum.veilvpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.net.wifi.WifiInfo
import android.os.Build
import org.json.JSONObject

/**
 * Per-network protection status and unsafe-network alerts.
 *
 * When the phone joins a Wi-Fi network while VEIL is off, the user gets one notification with a
 * one-tap "Protect now" fix. Open (unencrypted) and WEP networks, and networks with a sign-in page,
 * get a stronger warning. Everything is decided on the phone: nothing about the network (name,
 * address, security type) is sent to Infinitum. The network name is never read.
 */
object NetworkGuard {
    private const val CHANNEL = "alerts"
    const val ALERT_ID = 2
    private const val PREF_ALERTS = "alerts"
    private const val QUIET_MS = 15 * 60_000L        // at most one alert per network every 15 minutes

    /** The phone's current non-VPN network, as the interface shows it. */
    fun current(ctx: Context): JSONObject {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        // With the tunnel up the active network is the VPN, so look at the real ones. Android routes
        // through Wi-Fi (or Ethernet) when it is available, so rank those before mobile data.
        @Suppress("DEPRECATION")
        val net = cm.allNetworks.mapNotNull { n -> cm.getNetworkCapabilities(n)?.let { n to it } }
            .filter { (_, c) -> c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) }
            .minByOrNull { (_, c) ->
                when {
                    c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> 0
                    c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> 1
                    c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> 2
                    else -> 3
                }
            }?.first
        return assess(cm, net).put("protected", protectedNow(ctx))
    }

    /** type: wifi | cellular | ethernet | none; risk: open | wep | captive | none. */
    fun assess(cm: ConnectivityManager, net: Network?): JSONObject {
        val caps = net?.let { cm.getNetworkCapabilities(it) } ?: return JSONObject().put("type", "none").put("risk", "none")
        val type = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        var risk = "none"
        if (type == "wifi" && Build.VERSION.SDK_INT >= 31) {
            // Security type is available without location access; the network name stays hidden.
            when ((caps.transportInfo as? WifiInfo)?.currentSecurityType) {
                WifiInfo.SECURITY_TYPE_OPEN -> risk = "open"
                WifiInfo.SECURITY_TYPE_WEP -> risk = "wep"
            }
        }
        if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)) risk = "captive"
        return JSONObject().put("type", type).put("risk", risk)
    }

    /** VEIL's tunnel is up, or another always-on VPN is active. */
    private fun protectedNow(ctx: Context): Boolean {
        if (Vpn.state == "on") return true
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        return cm.getNetworkCapabilities(cm.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
    }

    fun alertsOn(ctx: Context) = ctx.getSharedPreferences("veil", Context.MODE_PRIVATE).getBoolean(PREF_ALERTS, true)

    /**
     * Asks Android to wake [Receiver] whenever a Wi-Fi network becomes available, even when the app
     * is closed. Registering again with the same intent replaces the earlier registration.
     */
    fun register(ctx: Context) {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val pi = pending(ctx)
        runCatching { cm.unregisterNetworkCallback(pi) }
        if (!alertsOn(ctx)) return
        val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching { cm.registerNetworkCallback(req, pi) }
    }

    // Mutable: Android adds the network to the intent. The intent is explicit, so only VEIL receives it.
    private fun pending(ctx: Context): PendingIntent = PendingIntent.getBroadcast(
        ctx, 10, Intent(ctx, Receiver::class.java).setAction("veil.NETWORK"),
        PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0))

    fun onNetwork(ctx: Context, net: Network?) {
        if (!alertsOn(ctx) || protectedNow(ctx)) return
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val a = assess(cm, net)
        if (a.getString("type") != "wifi") return
        val prefs = ctx.getSharedPreferences("veil", Context.MODE_PRIVATE)
        val handle = net?.networkHandle ?: 0L
        val now = System.currentTimeMillis()
        if (prefs.getLong("alert_net", -1L) == handle && now - prefs.getLong("alert_at", 0L) < QUIET_MS) return
        prefs.edit().putLong("alert_net", handle).putLong("alert_at", now).apply()
        notify(ctx, a.getString("risk"))
    }

    private fun notify(ctx: Context, risk: String) {
        val (title, text) = when (risk) {
            "open", "wep" -> "Unsafe Wi-Fi: not protected" to "This network is not encrypted. People nearby can see what you send. Tap Protect now."
            "captive" -> "Wi-Fi sign-in page" to "Sign in to this Wi-Fi, then tap Protect now so the network owner cannot see your traffic."
            else -> "Not protected on this Wi-Fi" to "The network owner can see which sites you visit. Tap Protect now."
        }
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Unsafe network alerts", NotificationManager.IMPORTANCE_HIGH))
        val server = ctx.getSharedPreferences("veil", Context.MODE_PRIVATE).getString("last_server", null)
        val open = PendingIntent.getActivity(ctx, 11, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        // One tap: connects straight away when VPN permission was already given; otherwise opens the app.
        val fix = if (server != null && VpnService.prepare(ctx) == null)
            PendingIntent.getForegroundService(ctx, 12, Intent(ctx, VeilService::class.java)
                .setAction(VeilService.ACTION_CONNECT).putExtra(VeilService.EXTRA_SERVER, server), PendingIntent.FLAG_IMMUTABLE)
        else open
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(fix)
            .setAutoCancel(true)
            .addAction(Notification.Action.Builder(null, "Protect now", fix).build())
            .build()
        runCatching { nm.notify(ALERT_ID, n) }   // no-op if the user turned notifications off
    }

    /** Replaces the alert when a one-tap connect fails, so the user is not left thinking they are safe. */
    fun failed(ctx: Context, code: String?) {
        val text = when (code) {
            "tor_unavailable" -> "This location has no Tor exit. Open VEIL to pick another, or turn Tor off."
            "server_offline" -> "That location is offline. Open VEIL to pick another."
            "pass_required" -> "VEIL is free: open the app and watch one short ad for 24 hours of protection."
            "network_unreachable" -> "No internet right now. VEIL will be ready when you are back online."
            else -> "VEIL could not connect. Open the app to try again."
        }
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Unsafe network alerts", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(ctx, 11, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Still not protected")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { nm.notify(ALERT_ID, n) }
    }

    fun clear(ctx: Context) = ctx.getSystemService(NotificationManager::class.java).cancel(ALERT_ID)

    /** Network events (registered above) and boot / app update, which clear registrations. */
    class Receiver : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> register(ctx)
                "veil.NETWORK" -> {
                    val net: Network? = if (Build.VERSION.SDK_INT >= 33)
                        intent.getParcelableExtra(ConnectivityManager.EXTRA_NETWORK, Network::class.java)
                    else @Suppress("DEPRECATION") intent.getParcelableExtra(ConnectivityManager.EXTRA_NETWORK)
                    onNetwork(ctx, net)
                }
            }
        }
    }
}
