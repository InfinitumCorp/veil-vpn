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
            c.connectTimeout = 8_000
            c.readTimeout = 10_000
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

    /** The session comes from signing in with Cumulus ID ([CidSignIn]); there is no anonymous one. */
    private fun session(): String? = prefs.getString("session", null)

    /** Gives a Cumulus ID access token to the control server once; it returns this device's session. */
    @Synchronized
    fun signIn(cidToken: String) {
        val (code, j) = raw("POST", "/v1/session", JSONObject().put("cid_token", cidToken), null)
        if (code != 200) throw ApiError(j.optString("error", "session_$code"))
        prefs.edit().putString("session", j.getString("token")).apply()
    }

    fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        val open = method == "GET" && (path == "/v1/servers" || path == "/v1/pool" || path.startsWith("/v1/ads?"))
        val token = session() ?: if (open) null else throw ApiError("sign_in_required")
        val (code, j) = raw(method, path, body, token)
        // The server no longer accepts this session: the person signs in again.
        if (code == 401) {
            prefs.edit().remove("session").remove("cid_profile").apply()
            throw ApiError("sign_in_required")
        }
        if (code !in 200..299) throw ApiError(j.optString("error", "http_$code"))
        return j
    }
}
