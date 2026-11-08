package com.infinitum.veilvpn

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Hosts the shared VEIL interface from app assets and connects it to the native tunnel. */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var vpnAsk: CompletableDeferred<Boolean>? = null

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        vpnAsk?.complete(it.resultCode == RESULT_OK)
    }

    /** [consent] is Android's IKEv2 profile consent screen; null asks for the WireGuard (VpnService) permission. */
    private suspend fun askVpnPermission(consent: Intent?): Boolean = withContext(Dispatchers.Main) {
        val intent = consent ?: VpnService.prepare(this@MainActivity) ?: return@withContext true
        val d = CompletableDeferred<Boolean>().also { vpnAsk = it }
        vpnPermission.launch(intent)
        d.await()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        // Debug builds only: lets chrome://inspect attach to the interface.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)

                // Anything outside the bundled interface (ads, links) opens in the user's browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == "appassets.androidplatform.net") return false
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    return true
                }
            }
        }
        web.addJavascriptInterface(Bridge(
            ctx = applicationContext,
            scope = lifecycleScope,
            reply = { id, result, error ->
                val js = "window.__veilReply(${JSONObject.quote(id)}, ${result ?: "null"}, ${if (error == null) "null" else JSONObject.quote(error)})"
                runOnUiThread { web.evaluateJavascript(js, null) }
            },
            askVpnPermission = ::askVpnPermission,
            openVpnSettings = { runOnUiThread { startActivity(Intent(Settings.ACTION_VPN_SETTINGS)) } },
        ), "VeilAndroid")

        // Android 15+ draws edge to edge: keep the interface clear of the status and navigation bars.
        val root = FrameLayout(this).apply { setBackgroundColor(Color.WHITE); addView(web) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else finish() }
        })

        NetworkGuard.register(applicationContext)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onDestroy() {
        web.removeJavascriptInterface("VeilAndroid")
        web.destroy()
        super.onDestroy()
    }
}
