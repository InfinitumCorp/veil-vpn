package com.infinitum.veilvpn

import android.content.Context
import android.webkit.JavascriptInterface
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

/**
 * JavaScript bridge used by the shared VEIL interface (window.VeilAndroid).
 * Every call is asynchronous: JS passes an id and gets the answer via window.__veilReply.
 */
class Bridge(
    private val ctx: Context,
    private val scope: CoroutineScope,
    private val reply: (id: String, result: String?, error: String?) -> Unit,
    private val askVpnPermission: suspend () -> Boolean,
    private val openVpnSettings: () -> Unit,
) {
    private val api = ControlApi(ctx)
    private val prefs = ctx.getSharedPreferences("veil", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun call(id: String, type: String, payload: String) {
        scope.launch(Dispatchers.IO) {
            try {
                val p = if (payload.isBlank()) JSONObject() else JSONObject(payload)
                reply(id, handle(type, p), null)
            } catch (e: ApiError) {
                reply(id, null, e.code)
            } catch (e: Exception) {
                reply(id, null, e.javaClass.simpleName)
            }
        }
    }

    private suspend fun handle(type: String, p: JSONObject): String = when (type) {
        "state" -> Vpn.snapshot().also {
            if (it.isNull("server")) it.put("server", prefs.getString("last_server", null))
            it.put("network", NetworkGuard.current(ctx))   // decided on the phone, never sent anywhere
        }.toString()
        "servers" -> {
            val list: JSONArray = api.call("GET", "/v1/servers").getJSONArray("servers")
            for (i in 0 until list.length()) list.getJSONObject(i).let {
                prefs.edit().putString("server_name_${it.getString("id")}", it.getString("city")).apply()
            }
            list.toString()
        }
        "connect" -> {
            val server = p.getString("server")
            if (!askVpnPermission()) throw ApiError("vpn_permission_denied")
            prefs.edit().putString("last_server", server).apply()
            VeilService.connect(ctx, server)
            // Wait briefly for the first handshake; the UI keeps polling "state" after this.
            withTimeoutOrNull(12_000) { while (Vpn.state == "connecting" || Vpn.state == "off") delay(250) }
            if (Vpn.state == "off" && Vpn.lastError != null) throw ApiError(Vpn.lastError!!)
            Vpn.snapshot().toString()
        }
        "disconnect" -> {
            VeilService.disconnect(ctx)
            withTimeoutOrNull(5_000) { while (Vpn.state != "off") delay(100) }
            Vpn.snapshot().toString()
        }
        "me" -> api.call("GET", "/v1/me").toString()
        "pool" -> api.call("GET", "/v1/pool").toString()
        "revenue" -> api.call("GET", "/v1/revenue").toString()
        "blocked" -> api.call("GET", "/v1/blocked").toString()
        "ad" -> api.call("GET", "/v1/ads?region=" + URLEncoder.encode(p.optString("region", "global"), "UTF-8")).toString()
        "adEvent" -> api.call("POST", "/v1/ads/event", JSONObject().put("ad", p.getString("ad")).put("kind", p.getString("kind"))).toString()
        "wallet" -> api.call("POST", "/v1/wallet", JSONObject().put("address", p.opt("address") ?: JSONObject.NULL)).toString()
        "claim" -> api.call("POST", "/v1/claim").toString()
        "settings" -> JSONObject()
            .put("earn", prefs.getBoolean("earn", true))
            .put("auto", prefs.getBoolean("auto", false))
            .put("tor", prefs.getBoolean("tor", false))
            .put("block", prefs.getBoolean("block", true))
            .put("alerts", prefs.getBoolean("alerts", true))
            .toString()
        "setting" -> {
            when (val k = p.getString("key")) {
                "earn", "auto" -> prefs.edit().putBoolean(k, p.getBoolean("value")).apply()
                "alerts" -> { prefs.edit().putBoolean(k, p.getBoolean("value")).apply(); NetworkGuard.register(ctx) }
                "tor", "block" -> {
                    prefs.edit().putBoolean(k, p.getBoolean("value")).apply()
                    // Re-register with the node so it updates this device's Tor and blocking settings.
                    val server = Vpn.server
                    if (Vpn.state != "off" && server != null) runCatching { Vpn.connect(ctx, server, reconnect = true) }
                }
                "kill" -> openVpnSettings()   // Android's own Always-on VPN + block switch
            }
            "{}"
        }
        else -> throw ApiError("unknown_call")
    }
}
