package com.infinitum.veilvpn

import android.content.Context
import com.amplitude.android.Amplitude
import com.amplitude.android.AutocaptureOption
import com.amplitude.android.Configuration
import com.amplitude.android.TrackingOptions
import com.amplitude.core.ServerZone
import com.amplitude.core.events.BaseEvent
import com.amplitude.core.platform.Plugin

/**
 * Amplitude product analytics: app opens and sessions, nothing else.
 *
 * VEIL is a privacy VPN, so this never sees what the person does with the tunnel: no visited
 * hosts, no IP addresses (theirs or a server's), no VPN location, protocol or account. Only the
 * SDK's own lifecycle and session events are sent, and [Allowlist] drops any other event and
 * strips every event and user property before it leaves the device. No user is ever identified.
 *
 * The key below is Infinitum's public client key (it ships in every client); the Secret key never
 * leaves the server side.
 */
object Analytics {
    private const val PUBLIC_API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8"
    private var amplitude: Amplitude? = null

    fun start(ctx: Context) {
        if (amplitude != null) return
        amplitude = Amplitude(Configuration(
            apiKey = PUBLIC_API_KEY,
            context = ctx.applicationContext,
            serverZone = ServerZone.US,
            // App open (lifecycle) and sessions only: no screen views, deep links (they carry the
            // Cumulus ID sign-in code), element interactions or other autocapture.
            autocapture = setOf(AutocaptureOption.SESSIONS, AutocaptureOption.APP_LIFECYCLES),
            trackingOptions = TrackingOptions()
                .disableIpAddress()
                .disableCity()
                .disableDma()
                .disableLatLng()
                .disableAdid()
                .disableCarrier(),
            useAdvertisingIdForDeviceId = false,
            useAppSetIdForDeviceId = false,
            locationListening = false,
            enableDiagnostics = false,
            enableAutocaptureRemoteConfig = false,
        )).also { it.add(Allowlist) }
    }

    /** Last line of defence: only lifecycle and session events, with no properties at all. */
    private object Allowlist : Plugin {
        override val type = Plugin.Type.Enrichment
        override lateinit var amplitude: com.amplitude.core.Amplitude
        private val allowed = setOf(
            "[Amplitude] Application Opened",
            "[Amplitude] Application Backgrounded",
            "[Amplitude] Application Installed",
            "[Amplitude] Application Updated",
            "session_start",
            "session_end",
        )

        override fun execute(event: BaseEvent): BaseEvent? {
            if (event.eventType !in allowed) return null
            event.userId = null
            event.eventProperties = null
            event.userProperties = null
            event.groups = null
            event.groupProperties = null
            event.ip = null
            event.country = null
            event.region = null
            event.city = null
            event.dma = null
            event.locationLat = null
            event.locationLng = null
            event.adid = null
            event.carrier = null
            return event
        }
    }
}
