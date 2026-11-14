package com.infinitum.veilvpn

import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import com.infinitum.veilvpn.xray.veilxray.Veilxray
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The VPN interface for the Xray tunnels (VLESS Reality and the HTTPS proxy, see [Xray]). It routes all IPv4 and
 * IPv6 traffic into the interface and hands the descriptor to Xray. VEIL itself is left out of its VPN, so Xray's
 * own connections to the node, and the app's calls to the control server, go out over the real network.
 */
class XrayVpnService : VpnService() {
    companion object {
        const val MTU = 1500
        private const val ACTION_START = "start"
        private const val ACTION_STOP = "stop"

        @Volatile private var pendingConfig: String? = null
        @Volatile private var result: Throwable? = null
        @Volatile private var started: CountDownLatch? = null
        @Volatile private var running: XrayVpnService? = null

        /** Starts (or restarts) the tunnel with [config] and waits until Xray runs. Throws if it did not start. */
        fun start(ctx: Context, config: String) {
            if (VpnService.prepare(ctx) != null) throw ApiError("vpn_permission_denied")
            val latch = CountDownLatch(1)
            pendingConfig = config; result = null; started = latch
            ctx.startService(Intent(ctx, XrayVpnService::class.java).setAction(ACTION_START))
            if (!latch.await(15, TimeUnit.SECONDS)) throw IllegalStateException("xray_start_timeout")
            result?.let { throw it }
        }

        fun stop(ctx: Context) {
            if (running == null && !Veilxray.running()) return
            ctx.startService(Intent(ctx, XrayVpnService::class.java).setAction(ACTION_STOP))
        }

        fun isUp() = running != null && Veilxray.running()
    }

    private var tun: ParcelFileDescriptor? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val latch = started
                try {
                    val cfg = pendingConfig ?: throw IllegalStateException("no_config")
                    pendingConfig = null
                    Veilxray.stop()
                    val fd = tun ?: establish().also { tun = it }
                    Veilxray.start(fd.fd.toLong(), cfg)
                    running = this
                } catch (e: Throwable) {
                    result = e
                    shutdown()
                }
                latch?.countDown()
            }
            ACTION_STOP -> shutdown()
        }
        return START_NOT_STICKY
    }

    private fun establish(): ParcelFileDescriptor {
        val b = Builder()
            .setSession("VEIL</>™")
            .setMtu(MTU)
            .addAddress("10.70.0.2", 30)
            .addRoute("0.0.0.0", 0)
            .addAddress("fd70:7665:696c::2", 126)
            .addRoute("::", 0)
            // Answered by Xray (DoH through the tunnel); Android's Private DNS, if set, also goes through the tunnel.
            .addDnsServer("1.1.1.1")
            .addDisallowedApplication(packageName)
        if (Build.VERSION.SDK_INT >= 29) b.setMetered(false)
        return b.establish() ?: throw ApiError("vpn_permission_denied")
    }

    private fun shutdown() {
        runCatching { Veilxray.stop() }
        runCatching { tun?.close() }
        tun = null
        if (running === this) running = null
        stopSelf()
    }

    /** Another VPN app took over, or the user switched VEIL off in Android's settings. */
    override fun onRevoke() { shutdown(); Vpn.revoked() }

    override fun onDestroy() { shutdown(); super.onDestroy() }
}
