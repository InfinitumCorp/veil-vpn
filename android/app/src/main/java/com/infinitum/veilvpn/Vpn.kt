package com.infinitum.veilvpn

import android.content.Context
import android.net.TrafficStats
import android.os.Process
import android.telephony.TelephonyManager
import com.infinitum.veilvpn.xray.veilxray.Veilxray
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import com.wireguard.config.InetNetwork
import com.wireguard.config.Interface
import com.wireguard.config.Peer
import com.wireguard.crypto.Key
import com.wireguard.crypto.KeyPair
import org.json.JSONObject
import java.net.InetAddress

/**
 * Owns the single VPN tunnel. All functions block: call from a background thread.
 * "on" is reported only after a WireGuard handshake with the node (or, for the Xray tunnels, a page actually
 * fetched through the node), never just because the tunnel interface is up.
 *
 * Where WireGuard is blocked (Russia's TSPU lets the handshake through and then drops the data), the app uses
 * Xray instead: VLESS Reality where the node offers it, otherwise the node's HTTPS proxy on 443. It starts that
 * way on a Russian mobile network, and switches over by itself when WireGuard handshakes but nothing comes back.
 */
object Vpn {
    private const val HANDSHAKE_FRESH_MS = 180_000L   // WireGuard re-handshakes every 2 minutes
    /** After a fallback, keep using Xray for this long before trying WireGuard again. */
    private const val STEALTH_MS = 24 * 3_600_000L
    /** WireGuard counts as stalled when, this long after the handshake, it sent this much and got almost nothing. */
    private const val STALL_AFTER_MS = 8_000L
    private const val STALL_TX = 12_000L
    private const val STALL_RX = 2_000L
    private const val PROBE_EVERY_MS = 60_000L
    private const val PROBE_FRESH_MS = 180_000L
    private val XRAY_MODES = setOf("vless", "proxy")

    @Volatile var state = "off"; private set
    @Volatile var server: String? = null; private set
    @Volatile var region = "global"; private set
    @Volatile var since = 0L; private set
    @Volatile var rx = 0L; private set
    @Volatile var tx = 0L; private set
    @Volatile var lastError: String? = null; private set
    @Volatile var tor = false; private set
    /**
     * "wireguard" (VEIL's own tunnel), "ikev2" (Android's built-in IKEv2 client, Android 11+), or the Xray
     * tunnels for blocked networks: "vless" (VLESS Reality) or "proxy" (the node's HTTPS proxy).
     */
    @Volatile var protocol = "wireguard"; private set

    /** The protocol chosen in Settings; IKEv2 falls back to WireGuard below Android 11. */
    fun chosenProtocol(ctx: Context): String {
        val p = ctx.getSharedPreferences("veil", Context.MODE_PRIVATE).getString("proto", "wireguard")
        return if (p == "ikev2" && Ikev2.supported()) "ikev2" else "wireguard"
    }

    private var backend: GoBackend? = null
    private var peerKey: Key? = null
    private var assignedIp: String? = null
    // WireGuard counters when the handshake first came in, for the stall check.
    private var onRx = -1L
    private var onTx = -1L
    // Xray: the last time a page came back through the node, the last attempt, and the app's byte counts at the start.
    private var probeOk = 0L
    private var probeAt = 0L
    private var uidRx0 = 0L
    private var uidTx0 = 0L

    /** True on a Russian mobile network (or SIM), or for a day after WireGuard was found blocked. */
    fun stealthPreferred(ctx: Context): Boolean {
        val until = ctx.getSharedPreferences("veil", Context.MODE_PRIVATE).getLong("stealth_until", 0L)
        if (until > System.currentTimeMillis()) return true
        val tm = ctx.getSystemService(TelephonyManager::class.java) ?: return false
        return listOf(runCatching { tm.networkCountryIso }.getOrNull(), runCatching { tm.simCountryIso }.getOrNull())
            .any { it.equals("ru", ignoreCase = true) }
    }

    /** WireGuard got a handshake but its data is not coming back: the network is dropping it. */
    fun stalled(): Boolean {
        if (protocol != "wireguard" || state != "on" || onRx < 0 || since == 0L) return false
        if (System.currentTimeMillis() - since < STALL_AFTER_MS) return false
        return tx - onTx > STALL_TX && rx - onRx < STALL_RX
    }

    /** Switches this connection from WireGuard to Xray, and remembers the choice for a day. */
    @Synchronized
    fun fallBack(ctx: Context) {
        val serverId = server ?: return
        ctx.getSharedPreferences("veil", Context.MODE_PRIVATE).edit()
            .putLong("stealth_until", System.currentTimeMillis() + STEALTH_MS).apply()
        connect(ctx, serverId, reconnect = true)
    }

    /** The user, or another VPN app, took the Xray tunnel away. */
    fun revoked() { if (protocol in XRAY_MODES && state != "off") state = "error" }

    private val tunnel = object : Tunnel {
        override fun getName() = "veil"
        override fun onStateChange(newState: Tunnel.State) {
            if (newState == Tunnel.State.DOWN && state != "off") state = "error"
        }
    }

    private fun backend(ctx: Context) = backend ?: GoBackend(ctx.applicationContext).also { backend = it }

    /**
     * The device key is created once and stored encrypted by [KeyVault]. A key saved in plain
     * text by an earlier version is moved to encrypted storage. If the Keystore key is lost
     * (for example after a device restore), a new WireGuard key is made; the server simply
     * sees a new device key on the next connect.
     */
    private fun keyPair(ctx: Context): KeyPair {
        val prefs = ctx.getSharedPreferences("veil", Context.MODE_PRIVATE)
        prefs.getString("wg_private", null)?.let { plain ->
            prefs.edit().putString("wg_private_sealed", KeyVault.seal(plain)).remove("wg_private").apply()
            return KeyPair(Key.fromBase64(plain))
        }
        prefs.getString("wg_private_sealed", null)?.let { sealed ->
            runCatching { KeyVault.open(sealed) }.getOrNull()?.let { return KeyPair(Key.fromBase64(it)) }
        }
        val kp = KeyPair()
        prefs.edit().putString("wg_private_sealed", KeyVault.seal(kp.privateKey.toBase64())).apply()
        return kp
    }

    @Synchronized
    fun connect(ctx: Context, serverId: String, reconnect: Boolean = false) {
        if (!reconnect) { state = "connecting"; since = 0L }
        server = serverId
        lastError = null
        try {
            // Tor over VPN: the node redirects this device's traffic into Tor (Settings switch).
            val prefs = ctx.getSharedPreferences("veil", Context.MODE_PRIVATE)
            val wantTor = prefs.getBoolean("tor", false)
            val wantBlock = prefs.getBoolean("block", true)   // tracker blocking: on unless switched off
            if (chosenProtocol(ctx) == "ikev2") return connectIkev2(ctx, serverId, reconnect, wantTor, wantBlock)
            if (protocol == "ikev2") { Ikev2.stop(ctx); protocol = "wireguard" }
            if (protocol in XRAY_MODES || stealthPreferred(ctx)) return connectXray(ctx, serverId, reconnect, wantTor, wantBlock)
            val kp = keyPair(ctx)
            val r = ControlApi(ctx).call("POST", "/v1/connect", JSONObject()
                .put("server", serverId).put("mode", "wireguard").put("publicKey", kp.publicKey.toBase64()).put("tor", wantTor).put("block", wantBlock))
            tor = r.optBoolean("tor", false)
            val wg = r.getJSONObject("wireguard")
            region = r.getJSONObject("server").optString("region", "global")
            val iface = Interface.Builder()
                .setKeyPair(kp)
                .addAddress(InetNetwork.parse(wg.getString("address")))
                .addDnsServer(InetAddress.getByName(wg.getString("dns")))
                // The app's own API calls stay outside the tunnel so it can always reach the
                // control server to reconnect. All other apps go through VEIL.
                .excludeApplication(ctx.packageName)
                .build()
            val peer = Peer.Builder()
                .parsePublicKey(wg.getString("peerPublicKey"))
                .parseEndpoint(wg.getString("endpoint"))
                .parseAllowedIPs(wg.getString("allowedIps"))
                .setPersistentKeepalive(wg.optInt("keepalive", 25))
                .build()
            val config = Config.Builder().setInterface(iface).addPeer(peer).build()
            val ip = wg.getString("address")
            if (!reconnect || ip != assignedIp || backend(ctx).getState(tunnel) != Tunnel.State.UP) {
                backend(ctx).setState(tunnel, Tunnel.State.UP, config)
            }
            if (peerKey != peer.publicKey || ip != assignedIp) { onRx = -1L; onTx = -1L }
            peerKey = peer.publicKey
            assignedIp = ip
            if (!reconnect) state = "connecting"
            check(ctx)
        } catch (e: Exception) {
            lastError = (e as? ApiError)?.code ?: e.javaClass.simpleName
            if (!reconnect) {
                if (protocol == "ikev2") Ikev2.stop(ctx)
                else if (protocol in XRAY_MODES) XrayVpnService.stop(ctx)
                else runCatching { backend(ctx).setState(tunnel, Tunnel.State.DOWN, null) }
                state = "off"
            } else state = "error"
            throw e
        }
    }

    /**
     * IKEv2: the control server's login goes into Android's IKEv2 profile. On a lease renewal while
     * the session is up nothing is restarted (the login stays the same; the server just extends it).
     */
    private fun connectIkev2(ctx: Context, serverId: String, reconnect: Boolean, wantTor: Boolean, wantBlock: Boolean) {
        val r = ControlApi(ctx).call("POST", "/v1/connect", JSONObject()
            .put("server", serverId).put("mode", "ikev2").put("tor", wantTor).put("block", wantBlock))
        tor = r.optBoolean("tor", false)
        region = r.getJSONObject("server").optString("region", "global")
        val switching = protocol != "ikev2"
        if (switching) {
            runCatching { backend(ctx).setState(tunnel, Tunnel.State.DOWN, null) }
            peerKey = null; assignedIp = null
        }
        protocol = "ikev2"
        if (switching || !reconnect || !Ikev2.connected(ctx)) {
            if (Ikev2.provision(ctx, r.getJSONObject("ikev2")) != null) throw ApiError("vpn_permission_denied")
            Ikev2.start(ctx)
        }
        if (!reconnect) state = "connecting"
        check(ctx)
    }

    /**
     * The Xray tunnels: VLESS Reality when the node has it, else the node's HTTPS proxy. On a lease renewal the
     * running tunnel keeps its connections; only the proxy's token is swapped in.
     */
    private fun connectXray(ctx: Context, serverId: String, reconnect: Boolean, wantTor: Boolean, wantBlock: Boolean) {
        val api = ControlApi(ctx)
        fun call(mode: String) = api.call("POST", "/v1/connect", JSONObject()
            .put("server", serverId).put("mode", mode).put("tor", wantTor).put("block", wantBlock))
        var mode = if (reconnect && protocol == "proxy" && XrayVpnService.isUp()) "proxy" else "vless"
        val r = try { call(mode) } catch (e: ApiError) {
            // Nodes without VLESS (or with Xray down) say so; their HTTPS proxy is always there.
            if (mode == "vless" && (e.code == "vless_unavailable" || e.code == "server_offline")) { mode = "proxy"; call(mode) } else throw e
        }
        tor = r.optBoolean("tor", false)
        region = r.getJSONObject("server").optString("region", "global")
        val outbound = if (mode == "vless") {
            val v = r.getJSONObject("vless")
            Xray.vlessOutbound(v, resolve(v.getString("host")))
        } else {
            val p = r.getJSONObject("proxy")
            Xray.proxyOutbound(p, resolve(p.getString("host")))
        }
        if (peerKey != null || runCatching { backend?.getState(tunnel) }.getOrNull() == Tunnel.State.UP) {
            runCatching { backend(ctx).setState(tunnel, Tunnel.State.DOWN, null) }
        }
        peerKey = null; assignedIp = null; onRx = -1L; onTx = -1L
        if (reconnect && protocol == mode && XrayVpnService.isUp()) {
            Veilxray.updateOutbound(outbound.toString())
        } else {
            XrayVpnService.start(ctx, Xray.config(outbound, udp = mode == "vless"))
            uidRx0 = TrafficStats.getUidRxBytes(Process.myUid()); uidTx0 = TrafficStats.getUidTxBytes(Process.myUid())
            probeAt = 0L
            if (protocol != mode) probeOk = 0L
        }
        protocol = mode
        if (!reconnect) state = "connecting"
        check(ctx)
    }

    /** The node's address, looked up outside the VPN (VEIL is excluded from its own tunnel). */
    private fun resolve(host: String): String =
        if (Xray.isIp(host)) host else InetAddress.getAllByName(host).let { a -> (a.firstOrNull { it.address.size == 4 } ?: a.first()).hostAddress!! }

    /** Refreshes counters and decides between connecting / on / error from the last handshake. */
    fun check(ctx: Context): String {
        if (state == "off") return state
        if (protocol == "ikev2") {
            val up = Ikev2.connected(ctx)
            state = when {
                up -> { if (since == 0L) since = System.currentTimeMillis(); "on" }
                state == "on" -> "error"
                else -> state
            }
            return state
        }
        if (protocol in XRAY_MODES) return checkXray()
        val key = peerKey ?: return state
        val stats = runCatching { backend(ctx).getStatistics(tunnel) }.getOrNull() ?: return state
        rx = stats.totalRx(); tx = stats.totalTx()
        val hs = stats.peer(key)?.latestHandshakeEpochMillis() ?: 0L
        val fresh = hs > 0 && System.currentTimeMillis() - hs < HANDSHAKE_FRESH_MS
        state = when {
            fresh -> {
                if (since == 0L) since = System.currentTimeMillis()
                if (onRx < 0) { onRx = rx; onTx = tx }
                "on"
            }
            state == "on" -> "error"          // was protected, handshakes stopped
            else -> state                     // still waiting for the first handshake
        }
        return state
    }

    /** Xray: "on" while a page fetched through the node came back in the last few minutes. */
    private fun checkXray(): String {
        val now = System.currentTimeMillis()
        if (!XrayVpnService.isUp()) { if (state == "on") state = "error"; return state }
        rx = (TrafficStats.getUidRxBytes(Process.myUid()) - uidRx0).coerceAtLeast(0L)
        tx = (TrafficStats.getUidTxBytes(Process.myUid()) - uidTx0).coerceAtLeast(0L)
        if (now - probeAt >= (if (now - probeOk < PROBE_FRESH_MS) PROBE_EVERY_MS else 0L)) {
            probeAt = now
            if (runCatching { Veilxray.probe(10_000L) }.isSuccess) probeOk = System.currentTimeMillis()
        }
        state = when {
            System.currentTimeMillis() - probeOk < PROBE_FRESH_MS -> { if (since == 0L) since = System.currentTimeMillis(); "on" }
            state == "on" -> "error"
            else -> state
        }
        return state
    }

    @Synchronized
    fun disconnect(ctx: Context) {
        if (protocol in XRAY_MODES) { XrayVpnService.stop(ctx); protocol = "wireguard" }
        else if (protocol == "ikev2") Ikev2.stop(ctx)
        else runCatching { backend(ctx).setState(tunnel, Tunnel.State.DOWN, null) }
        runCatching { ControlApi(ctx).call("POST", "/v1/disconnect") }
        state = "off"; since = 0L; rx = 0L; tx = 0L; peerKey = null; assignedIp = null; tor = false
        onRx = -1L; onTx = -1L; probeOk = 0L; probeAt = 0L
    }

    fun snapshot(): JSONObject = JSONObject()
        .put("state", state).put("server", server).put("region", region)
        .put("since", since).put("rx", rx).put("tx", tx).put("error", lastError).put("tor", tor)
        .put("protocol", protocol)
}
