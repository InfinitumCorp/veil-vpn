package com.infinitum.veilvpn

import android.app.Activity
import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.browser.customtabs.CustomTabsIntent
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * "Sign in with Cumulus ID" (OAuth 2.0 code + PKCE) for the app.
 *
 * 1. [start] opens Cumulus ID (BuildConfig.CID_ISSUER: id.cumuluscloud.app, or a mirror reachable from
 *    Russia) in a Custom Tab. "Create a Cumulus ID" asks for the sign-up page (prompt=create).
 * 2. Cumulus ID sends the browser to the VEIL VPN site's return page (BuildConfig.CID_RETURN), which
 *    hands the one-time code to this app: directly as a verified App Link, or through the
 *    BuildConfig.CID_SCHEME://cid link the page opens.
 * 3. [finish] trades the code for a CID access token and gives that token once to the control server,
 *    which ties this device's session to the person. The token itself is not kept.
 */
object CidSignIn {
    private const val CLIENT = "veil-vpn"
    private val issuer get() = BuildConfig.CID_ISSUER.trimEnd('/')
    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("veil", Context.MODE_PRIVATE)
    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    private fun random(n: Int) = b64(ByteArray(n).also { SecureRandom().nextBytes(it) })

    fun signedIn(ctx: Context): Boolean = prefs(ctx).getString("session", null) != null && prefs(ctx).getString("cid_profile", null) != null

    fun account(ctx: Context): JSONObject {
        val p = prefs(ctx)
        val out = JSONObject().put("signedIn", signedIn(ctx))
            .put("profile", p.getString("cid_profile", null)?.let { JSONObject(it) } ?: JSONObject.NULL)
        p.getString("cid_error", null)?.let { out.put("error", it); p.edit().remove("cid_error").apply() }
        return out
    }

    fun start(activity: Activity, create: Boolean) {
        val verifier = random(48)
        val challenge = b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        val state = random(16)
        prefs(activity).edit().putString("cid_verifier", verifier).putString("cid_state", state)
            .putLong("cid_at", System.currentTimeMillis()).remove("cid_error").apply()
        val uri = Uri.parse("$issuer/api/id/authorize").buildUpon()
            .appendQueryParameter("client_id", CLIENT)
            .appendQueryParameter("redirect_uri", BuildConfig.CID_RETURN)
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("state", state)
            .apply { if (create) appendQueryParameter("prompt", "create") }
            .build()
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, uri)
    }

    /** True when [uri] is a sign-in coming back to this app. */
    fun isReturn(uri: Uri?): Boolean = uri != null && uri.getQueryParameter("code") != null && (
        (uri.scheme == BuildConfig.CID_SCHEME && uri.host == "cid") ||
            (uri.scheme == "https" && uri.host == Uri.parse(BuildConfig.CID_RETURN).host && uri.path?.startsWith("/app-signin") == true))

    /** Blocking: call off the main thread. Errors are kept for the interface to show. */
    fun finish(ctx: Context, uri: Uri) {
        val p = prefs(ctx)
        val verifier = p.getString("cid_verifier", null)
        val state = p.getString("cid_state", null)
        val fresh = System.currentTimeMillis() - p.getLong("cid_at", 0) < 30 * 60_000
        p.edit().remove("cid_verifier").remove("cid_state").remove("cid_at").apply()
        try {
            if (verifier == null || state == null || !fresh || uri.getQueryParameter("state") != state) throw ApiError("cid_mismatch")
            val tok = post("$issuer/api/id/token", JSONObject()
                .put("code", uri.getQueryParameter("code")).put("code_verifier", verifier)
                .put("client_id", CLIENT).put("redirect_uri", BuildConfig.CID_RETURN))
            val access = tok.optString("access_token").takeIf { it.isNotEmpty() } ?: throw ApiError("cid_failed")
            ControlApi(ctx).signIn(access)
            val profile = tok.optJSONObject("profile") ?: JSONObject()
            p.edit().putString("cid_profile", JSONObject()
                .put("username", profile.opt("username") ?: JSONObject.NULL)
                .put("email", profile.opt("email") ?: JSONObject.NULL).toString()).apply()
        } catch (e: ApiError) {
            p.edit().putString("cid_error", e.code).apply()
        } catch (e: Exception) {
            p.edit().putString("cid_error", "cid_failed").apply()
        }
    }

    fun signOut(ctx: Context) {
        prefs(ctx).edit().remove("session").remove("cid_profile").apply()
    }

    private fun post(url: String, body: JSONObject): JSONObject {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"; c.connectTimeout = 10_000; c.readTimeout = 15_000; c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw ApiError("cid_failed")
            return JSONObject(text)
        } catch (e: java.io.IOException) {
            throw ApiError("cid_unreachable")
        } finally {
            c.disconnect()
        }
    }
}
