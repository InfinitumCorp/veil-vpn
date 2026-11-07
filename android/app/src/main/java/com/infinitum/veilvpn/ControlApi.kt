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

    @Synchronized
    private fun session(): String {
        prefs.getString("session", null)?.let { return it }
        val (code, j) = raw("POST", "/v1/session", null, null)
        if (code != 200) throw ApiError(j.optString("error", "session_$code"))
        val t = j.getString("token")
        prefs.edit().putString("session", t).apply()
        return t
    }

    fun call(method: String, path: String, body: JSONObject? = null, retry: Boolean = true): JSONObject {
        val (code, j) = raw(method, path, body, session())
        if (code == 401 && retry) {
            prefs.edit().remove("session").apply()
            return call(method, path, body, false)
        }
        if (code !in 200..299) throw ApiError(j.optString("error", "http_$code"))
        return j
    }
}
