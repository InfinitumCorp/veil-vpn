package com.infinitum.veilvpn

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class ApiError(val code: String) : Exception(code)

/** Client for the VEIL control server. Blocking: call from a background thread. */
class ControlApi(context: Context) {
    private val app = context.applicationContext
    private val prefs = context.applicationContext.getSharedPreferences("veil", Context.MODE_PRIVATE)
    private val base = BuildConfig.CONTROL_URL.trimEnd('/')

    private fun raw(method: String, path: String, body: JSONObject?, token: String?): Pair<Int, JSONObject> {
        val c = URL(base + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            // Generous limits: on filtered mobile networks (e.g. Russia) the TLS handshake alone can take 10 s or more.
            c.connectTimeout = 15_000
            c.readTimeout = 20_000
            c.useCaches = false
            c.setRequestProperty("content-type", "application/json")
            c.setRequestProperty("x-veil-device", DeviceCheck.id(app))
            c.setRequestProperty("x-veil-platform", "android")
            DeviceCheck.integrity(app).takeIf { it.isNotEmpty() }?.let { c.setRequestProperty("x-veil-integrity", it) }
            if (token != null) c.setRequestProperty("authorization", "Bearer $token")
            if (body != null) {
                c.doOutput = true
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            return code to (if (text.isBlank()) JSONObject() else JSONObject(text))
        } catch (e: java.io.IOException) {
            throw ApiError("network_unreachable")
        } finally {
            c.disconnect()
        }
    }

    /** The stored session: tied to a Cumulus ID after signing in ([CidSignIn]), otherwise anonymous. */
    private fun session(): String? = prefs.getString("session", null)

    /** Anyone may use VEIL VPN without signing in: with no session yet, this gets an anonymous one. */
    @Synchronized
    private fun anonSession(): String {
        session()?.let { return it }
        val (code, j) = raw("POST", "/v1/session", JSONObject(), null)
        if (code != 200 || !j.has("token")) throw ApiError(j.optString("error", "session_$code"))
        val token = j.getString("token")
        prefs.edit().putString("session", token).apply()
        return token
    }

    /** Gives a Cumulus ID access token to the control server once; it returns this device's session. */
    @Synchronized
    fun signIn(cidToken: String) {
        val (code, j) = raw("POST", "/v1/session", JSONObject().put("cid_token", cidToken), null)
        if (code != 200) throw ApiError(j.optString("error", "session_$code"))
        prefs.edit().putString("session", j.getString("token")).remove("pass").remove("pass_exp").apply()
    }

    /** The 24-hour pass earned by watching the start-up ad; tied to this device's session. */
    fun pass(): String? = prefs.getString("pass", null)?.takeIf { prefs.getLong("pass_exp", 0) > System.currentTimeMillis() + 60_000 }
    fun passExp(): Long = if (pass() != null) prefs.getLong("pass_exp", 0) else 0
    fun savePass(pass: String, exp: Long) { prefs.edit().putString("pass", pass).putLong("pass_exp", exp).apply() }

    fun call(method: String, path: String, body: JSONObject? = null, retried: Boolean = false): JSONObject {
        val open = method == "GET" && (path == "/v1/servers" || path == "/v1/pool" || path.startsWith("/v1/ads?"))
        val token = session() ?: if (open) null else anonSession()
        // Every connect (this phone or a set-up for another device) carries the ad pass.
        if (path == "/v1/connect" && body != null) pass()?.let { body.put("pass", it) }
        val (code, j) = raw(method, path, body, token)
        // The server no longer accepts this session: drop it and carry on with a fresh anonymous one.
        if (code == 401) {
            prefs.edit().remove("session").remove("cid_profile").remove("pass").remove("pass_exp").apply()
            if (!retried) return call(method, path, body, true)
            throw ApiError("sign_in_required")
        }
        if (code !in 200..299) throw ApiError(j.optString("error", "http_$code"))
        return j
    }
}
