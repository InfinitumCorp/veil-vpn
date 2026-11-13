package com.infinitum.veilvpn

import org.json.JSONArray
import org.json.JSONObject

/**
 * Xray configs for the two tunnels that get through where WireGuard is blocked (Russia's TSPU lets the WireGuard
 * handshake through and then drops the data):
 *
 *  - "vless": VLESS Reality to the node's Xray (needs the node provisioned with ENABLE_VLESS=1).
 *  - "proxy": the node's own HTTPS proxy on 443, which every node already runs. TCP only: DNS goes over DoH
 *    through the same tunnel, and other UDP (QUIC) is refused so apps fall back to TCP.
 *
 * Both run on [XrayVpnService]: Xray's "tun" inbound reads the VPN interface and sends every flow out through the
 * outbound tagged "proxy". Server addresses are resolved by the app beforehand (outside the VPN) and passed as IPs,
 * so Xray never needs DNS to reach the node.
 */
object Xray {
    const val TAG = "proxy"

    /** The whole config: TUN in, [outbound] out, DNS answered by Xray over DoH through [outbound]. */
    fun config(outbound: JSONObject, udp: Boolean): String = JSONObject()
        .put("log", JSONObject().put("loglevel", "warning"))
        .put("inbounds", JSONArray().put(JSONObject()
            .put("tag", "tun").put("protocol", "tun")
            .put("settings", JSONObject().put("name", "tun0").put("mtu", XrayVpnService.MTU))
            .put("sniffing", JSONObject().put("enabled", true).put("destOverride", JSONArray().put("http").put("tls")).put("routeOnly", true))))
        .put("outbounds", JSONArray()
            .put(outbound)
            .put(JSONObject().put("tag", "dns-out").put("protocol", "dns"))
            .put(JSONObject().put("tag", "block").put("protocol", "blackhole")))
        // No "+local": the DoH server is reached through the first outbound, the tunnel itself.
        .put("dns", JSONObject().put("servers", JSONArray().put("https://1.1.1.1/dns-query")).put("queryStrategy", "UseIPv4"))
        .put("routing", JSONObject().put("domainStrategy", "AsIs").put("rules", JSONArray()
            .put(JSONObject().put("type", "field").put("inboundTag", JSONArray().put("tun")).put("network", "udp").put("port", "53").put("outboundTag", "dns-out"))
            .put(JSONObject().put("type", "field").put("inboundTag", JSONArray().put("tun")).put("network", "udp")
                .put("outboundTag", if (udp) TAG else "block"))))
        .toString()

    /**
     * The node's HTTPS proxy (the `proxy` block of a /v1/connect answer in mode "proxy"). [ip] is the node's
     * address; the TLS name stays the node's hostname.
     */
    fun proxyOutbound(proxy: JSONObject, ip: String): JSONObject {
        val host = proxy.getString("host")
        val tls = proxy.optString("scheme", "https") == "https"
        return JSONObject()
            .put("tag", TAG).put("protocol", "http")
            .put("settings", JSONObject().put("servers", JSONArray().put(JSONObject()
                .put("address", ip).put("port", proxy.getInt("port"))
                .put("users", JSONArray().put(JSONObject().put("user", proxy.optString("username", "veil")).put("pass", proxy.getString("password")))))))
            .put("streamSettings", JSONObject().put("network", "tcp")
                .put("security", if (tls) "tls" else "none")
                .apply { if (tls) put("tlsSettings", JSONObject().put("serverName", host).put("fingerprint", "chrome")) })
    }

    /**
     * VLESS Reality, from the `vless` block of a /v1/connect answer in mode "vless": its `xray` client config
     * already holds the outbound tagged "proxy"; only the address is swapped for [ip].
     */
    fun vlessOutbound(bundle: JSONObject, ip: String): JSONObject {
        val outs = bundle.getJSONObject("xray").getJSONArray("outbounds")
        val out = (0 until outs.length()).map { outs.getJSONObject(it) }.first { it.optString("tag") == TAG }
        val o = JSONObject(out.toString())
        o.getJSONObject("settings").getJSONArray("vnext").getJSONObject(0).put("address", ip)
        return o
    }

    /** True when [host] is a literal IPv4 or IPv6 address. */
    fun isIp(host: String) = host.matches(Regex("^[0-9.]+$")) || host.contains(':')
}
