package com.infinitum.veilvpn

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.FrameLayout
import com.google.android.gms.ads.AdListener
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.LoadAdError
import com.google.ads.mediation.admob.AdMobAdapter
import com.google.android.gms.ads.MobileAds
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AdMob banner pinned under the VEIL interface. It asks for consent first through Google's User
 * Messaging Platform (required in the EEA, UK and Switzerland) and only then starts the SDK and
 * loads an ad. The slot stays collapsed until an ad has actually loaded.
 */
class Ads(private val activity: Activity, private val slot: FrameLayout) {
    private var banner: AdView? = null
    private val started = AtomicBoolean(false)
    // True when Google's consent service could not be reached (it is blocked on some networks,
    // e.g. in Russia). Ads are then requested non-personalized only.
    @Volatile private var npa = false

    fun start() {
        val consent = UserMessagingPlatform.getConsentInformation(activity)
        consent.requestConsentInfoUpdate(activity, ConsentRequestParameters.Builder().build(), {
            UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) { e ->
                if (e != null) Log.w(TAG, "consent form: ${e.message}")
                if (consent.canRequestAds()) startSdk()
            }
        }, { e ->
            Log.w(TAG, "consent service unreachable (${e.message}); non-personalized ads only")
            if (!consent.canRequestAds()) npa = true
            startSdk()
        })
        // Consent given in an earlier session: no need to wait for the update.
        if (consent.canRequestAds()) startSdk()
    }

    private fun startSdk() {
        if (!started.compareAndSet(false, true)) return
        Thread { MobileAds.initialize(activity) {} }.start()
        activity.runOnUiThread { loadBanner() }
    }

    private fun loadBanner() {
        if (activity.isFinishing || activity.isDestroyed) return
        val ad = AdView(activity).apply {
            adUnitId = BuildConfig.ADMOB_BANNER_ID
            setAdSize(AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(activity, widthDp()))
            adListener = object : AdListener() {
                override fun onAdLoaded() { slot.visibility = View.VISIBLE }
                override fun onAdFailedToLoad(error: LoadAdError) {
                    Log.w(TAG, "banner not loaded: ${error.code} ${error.message}")
                    slot.visibility = View.GONE
                }
            }
        }
        banner = ad
        slot.removeAllViews()
        slot.addView(ad)
        val req = AdRequest.Builder()
        if (npa) req.addNetworkExtrasBundle(AdMobAdapter::class.java, Bundle().apply { putString("npa", "1") })
        ad.loadAd(req.build())
    }

    private fun widthDp(): Int {
        val px = if (Build.VERSION.SDK_INT >= 30) activity.windowManager.currentWindowMetrics.bounds.width()
                 else activity.resources.displayMetrics.widthPixels
        return (px / activity.resources.displayMetrics.density).toInt()
    }

    private companion object { const val TAG = "VeilAds" }

    fun pause() { banner?.pause() }
    fun resume() { banner?.resume() }
    fun destroy() { banner?.destroy(); banner = null }
}
