package com.infinitum.veilvpn

/**
 * Build-gated geo hook. [BuildConfig.GEO_ROUTING] is false unless a local build passes
 * -PveilGeoRouting=true, and [Vpn] does not call this while that flag is off.
 * The WireGuard full tunnel stays the server list, normally 0.0.0.0/0, ::/0.
 * Turning the Settings switch on does not split that route.
 */
object GeoHook {
    fun allowedIps(serverAllowedIps: String): String = serverAllowedIps
}
