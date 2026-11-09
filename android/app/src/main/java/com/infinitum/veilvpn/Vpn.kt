package com.infinitum.veilvpn

import android.content.Context
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
 * Owns the single WireGuard tunnel. All functions block: call from a background thread.
 * "on" is reported only after a WireGuard handshake with the node, never just because
 * the tunnel interface is up.
 */
object Vpn {
    private const val HANDSHAKE_FRESH_MS = 180_000L   // WireGuard re-handshakes every 2 minutes

    @Volatile var state = "off"; private set
    @Volatile var server: String? = null; private set
    @Volatile var region = "global"; private set
    @Volatile var since = 0L; private set
    @Volatile var rx = 0L; private set
    @Volatile var tx = 0L; private set
    @Volatile var lastError: String? = null; private set
    @Volatile var tor = false; private set
    /** "wireguard" (VEIL's own tunnel) or "ikev2" (Android's built-in IKEv2 client, Android 11+). */
    @Volatile var protocol = "wireguard"; private set

    /** The protocol chosen in Settings; IKEv2 falls back to WireGuard below Android 11. */
    fun chosenProtocol(ctx: Context): String {
        val p = ctx.getSharedPreferences("veil", Context.MODE_PRIVATE).getString("proto", "wireguard")
        return if (p == "ikev2" && Ikev2.supported()) "ikev2" else "wireguard"
    }

    private var backend: GoBackend? = null
    private var peerKey: Key? = null
    private var assignedIp: String? = null

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
            val wantGeo = prefs.getBoolean("geo", false)      // geo routing: off unless the user opts in
            if (chosenProtocol(ctx) == "ikev2") return connectIkev2(ctx, serverId, reconnect, wantTor, wantBlock, wantGeo)
            if (protocol == "ikev2") { Ikev2.stop(ctx); protocol = "wireguard" }
            val kp = keyPair(ctx)
            val connectBody = JSONObject()
                .put("server", serverId).put("mode", "wireguard").put("publicKey", kp.publicKey.toBase64()).put("tor", wantTor).put("block", wantBlock)
            if (wantGeo) connectBody.put("geo", true)
            val r = ControlApi(ctx).call("POST", "/v1/connect", connectBody)
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
                .parseAllowedIPs(if (BuildConfig.GEO_ROUTING) GeoHook.allowedIps(wg.getString("allowedIps")) else wg.getString("allowedIps"))
                .setPersistentKeepalive(wg.optInt("keepalive", 25))
                .build()
            val config = Config.Builder().setInterface(iface).addPeer(peer).build()
            val ip = wg.getString("address")
            if (!reconnect || ip != assignedIp || backend(ctx).getState(tunnel) != Tunnel.State.UP) {
                backend(ctx).setState(tunnel, Tunnel.State.UP, config)
            }
            peerKey = peer.publicKey
            assignedIp = ip
            if (!reconnect) state = "connecting"
            check(ctx)
        } catch (e: Exception) {
            lastError = (e as? ApiError)?.code ?: e.javaClass.simpleName
            if (!reconnect) {
                if (protocol == "ikev2") Ikev2.stop(ctx)
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
    private fun connectIkev2(ctx: Context, serverId: String, reconnect: Boolean, wantTor: Boolean, wantBlock: Boolean, wantGeo: Boolean) {
        val connectBody = JSONObject()
            .put("server", serverId).put("mode", "ikev2").put("tor", wantTor).put("block", wantBlock)
        if (wantGeo) connectBody.put("geo", true)
        val r = ControlApi(ctx).call("POST", "/v1/connect", connectBody)
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
        val key = peerKey ?: return state
        val stats = runCatching { backend(ctx).getStatistics(tunnel) }.getOrNull() ?: return state
        rx = stats.totalRx(); tx = stats.totalTx()
        val hs = stats.peer(key)?.latestHandshakeEpochMillis() ?: 0L
        val fresh = hs > 0 && System.currentTimeMillis() - hs < HANDSHAKE_FRESH_MS
        state = when {
            fresh -> { if (since == 0L) since = System.currentTimeMillis(); "on" }
            state == "on" -> "error"          // was protected, handshakes stopped
            else -> state                     // still waiting for the first handshake
        }
        return state
    }

    @Synchronized
    fun disconnect(ctx: Context) {
        if (protocol == "ikev2") Ikev2.stop(ctx)
        else runCatching { backend(ctx).setState(tunnel, Tunnel.State.DOWN, null) }
        runCatching { ControlApi(ctx).call("POST", "/v1/disconnect") }
        state = "off"; since = 0L; rx = 0L; tx = 0L; peerKey = null; assignedIp = null; tor = false
    }

    fun snapshot(): JSONObject = JSONObject()
        .put("state", state).put("server", server).put("region", region)
        .put("since", since).put("rx", rx).put("tx", tx).put("error", lastError).put("tor", tor)
        .put("protocol", protocol)
}
