package com.infinitum.veilvpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Foreground service that supervises the tunnel while it is on: checks the WireGuard
 * handshake (or the Xray tunnel's probe) every 5 s, falls back from WireGuard to VLESS / the
 * HTTPS proxy when the network drops WireGuard data, reconnects with backoff, keeps the control-server session fresh,
 * and sends one reward heartbeat a minute while the user is actively using the phone.
 */
class VeilService : Service() {
    companion object {
        const val ACTION_CONNECT = "connect"
        const val ACTION_DISCONNECT = "disconnect"
        const val EXTRA_SERVER = "server"
        private const val CHANNEL = "vpn"
        private const val NOTIFY_ID = 1

        fun connect(ctx: Context, server: String) = ctx.startForegroundService(
            Intent(ctx, VeilService::class.java).setAction(ACTION_CONNECT).putExtra(EXTRA_SERVER, server))

        fun disconnect(ctx: Context) = ctx.startService(Intent(ctx, VeilService::class.java).setAction(ACTION_DISCONNECT))
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> {
                val server = intent.getStringExtra(EXTRA_SERVER) ?: return START_NOT_STICKY
                goForeground("Connecting…")
                loop?.cancel()
                loop = scope.launch { supervise(server) }
            }
            ACTION_DISCONNECT -> {
                loop?.cancel()
                scope.launch {
                    Vpn.disconnect(this@VeilService)
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    private suspend fun supervise(server: String) {
        try { Vpn.connect(this, server) } catch (e: Exception) {
            // Started from an alert's "Protect now" with the app closed: say why it did not work.
            NetworkGuard.failed(this, (e as? ApiError)?.code ?: Vpn.lastError)
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return
        }
        val api = ControlApi(this)
        val prefs = getSharedPreferences("veil", MODE_PRIVATE)
        var lastBeat = 0L
        var lastRefresh = System.currentTimeMillis()
        var backoff = 3_000L
        var lastShown = ""
        while (scope.isActive) {
            val now = System.currentTimeMillis()
            val st = Vpn.check(this)
            val label = when (st) {
                "on" -> "Protected · ${serverName(server)}"
                "error" -> "Connection lost · reconnecting"
                else -> "Connecting…"
            }
            if (label != lastShown) { goForeground(label); lastShown = label }
            if (st == "on") NetworkGuard.clear(this)   // the unsafe-network alert has been dealt with

            // WireGuard handshakes but nothing comes back (Russia's TSPU): move to VLESS / the HTTPS proxy.
            if (Vpn.stalled()) {
                goForeground("Switching to a protocol this network allows…"); lastShown = ""
                runCatching { Vpn.fallBack(this) }
                delay(2_000)
                continue
            }

            if (st == "error") {
                // Tunnel stays up with all routes, so traffic is held rather than leaked.
                delay(backoff)
                runCatching { Vpn.connect(this, server, reconnect = true) }
                backoff = (backoff * 2).coerceAtMost(60_000L)
                continue
            }
            backoff = 3_000L

            // The control server's connection lease lasts 15 minutes; renew it every 10.
            if (now - lastRefresh > 600_000L) {
                runCatching { Vpn.connect(this, server, reconnect = true) }
                lastRefresh = now
            }
            if (st == "on" && now - lastBeat >= 60_000L && prefs.getBoolean("earn", true)) {
                lastBeat = now
                val active = (getSystemService(POWER_SERVICE) as PowerManager).isInteractive
                runCatching { api.call("POST", "/v1/heartbeat", JSONObject().put("active", active)) }
                    .onFailure { if ((it as? ApiError)?.code == "not_connected") runCatching { Vpn.connect(this, server, reconnect = true) } }
            }
            delay(5_000)
        }
    }

    private fun serverName(id: String) =
        getSharedPreferences("veil", MODE_PRIVATE).getString("server_name_$id", null) ?: id

    private fun goForeground(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "VPN status", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, VeilService::class.java).setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("VEIL</>™")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Disconnect", stop).build())
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIFY_ID, n)
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
