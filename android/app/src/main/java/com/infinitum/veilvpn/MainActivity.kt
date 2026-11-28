package com.infinitum.veilvpn

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.graphics.Typeface
import android.widget.TextView
import android.view.Gravity
import android.widget.LinearLayout
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Hosts the shared VEIL interface from app assets and connects it to the native tunnel. */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var ads: Ads? = null
    private var vpnAsk: CompletableDeferred<Boolean>? = null

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        vpnAsk?.complete(it.resultCode == RESULT_OK)
    }

    private var notifyAsk: CompletableDeferred<Unit>? = null
    private val notifyPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        notifyAsk?.complete(Unit)
    }

    /**
     * Android 13+: ask to show notifications (the "VEIL is on" status and unsafe Wi-Fi alerts) the first
     * time someone connects, not at start-up, where the system dialog would cover the start-up ad.
     * Asked once; the answer never blocks connecting.
     */
    private suspend fun askNotifyPermissionOnce() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("veil", MODE_PRIVATE)
        if (prefs.getBoolean("asked_notify", false)) return
        prefs.edit().putBoolean("asked_notify", true).apply()
        val d = CompletableDeferred<Unit>().also { notifyAsk = it }
        notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        d.await()
    }

    /** [consent] is Android's IKEv2 profile consent screen; null asks for the WireGuard (VpnService) permission. */
    private suspend fun askVpnPermission(consent: Intent?): Boolean = withContext(Dispatchers.Main) {
        askNotifyPermissionOnce()
        val intent = consent ?: VpnService.prepare(this@MainActivity) ?: return@withContext true
        val d = CompletableDeferred<Boolean>().also { vpnAsk = it }
        vpnPermission.launch(intent)
        d.await()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Analytics.start(applicationContext)
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
            startSignIn = { create -> runOnUiThread { CidSignIn.start(this, create) } },
        ), "VeilAndroid")

        // Android 15+ draws edge to edge: keep the interface clear of the status and navigation bars.
        // AdMob runs in a skinny black ticker strip along the bottom: a small "AD" tag, then the
        // 320x50 banner. The strip stays collapsed until an ad loads.
        val dp = resources.displayMetrics.density
        val adSlot = FrameLayout(this)
        val adStrip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
            addView(TextView(this@MainActivity).apply {
                text = "AD"
                setTextColor(0xFF9A9A9A.toInt())
                textSize = 9f
                typeface = Typeface.MONOSPACE
                letterSpacing = 0.15f
                setPadding((10 * dp).toInt(), 0, (8 * dp).toInt(), 0)
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(adSlot, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { gravity = Gravity.CENTER_VERTICAL })
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(adStrip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
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

        ads = Ads(this, adStrip, adSlot).also { it.start() }
        handleSignIn(intent)
        NetworkGuard.register(applicationContext)
    }

    // Cumulus ID sends the person back here (App Link or the return page's link) with a one-time code.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSignIn(intent)
    }

    private fun handleSignIn(intent: Intent?) {
        val uri = intent?.data
        if (!CidSignIn.isReturn(uri)) return
        intent?.data = null
        lifecycleScope.launch(Dispatchers.IO) {
            CidSignIn.finish(applicationContext, uri!!)
            withContext(Dispatchers.Main) { web.evaluateJavascript("window.__veilSignedIn && window.__veilSignedIn()", null) }
        }
    }

    override fun onPause() { ads?.pause(); super.onPause() }
    override fun onResume() { super.onResume(); ads?.resume() }

    override fun onDestroy() {
        ads?.destroy()
        web.removeJavascriptInterface("VeilAndroid")
        web.destroy()
        super.onDestroy()
    }
}
