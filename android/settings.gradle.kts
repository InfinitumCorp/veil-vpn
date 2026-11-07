// Network workarounds (both optional; normal builds use google() and mavenCentral()):
//   -PgoogleMaven=https://redirector.gvt1.com/edgedl/android/maven2/
//       Google's own CDN for the same repository, when dl.google.com is unreachable.
//   -PmavenRelay=http://127.0.0.1:8899
//       A local relay that downloads with another HTTP client, when Java TLS downloads keep failing.
fun RepositoryHandler.veilRepos(googleMirror: String?, relay: String?, plugins: Boolean) {
    if (relay != null) {
        maven("$relay/google/") { isAllowInsecureProtocol = true }
        maven("$relay/central/") { isAllowInsecureProtocol = true }
        if (plugins) maven("$relay/plugins/") { isAllowInsecureProtocol = true }
        return
    }
    if (googleMirror != null) maven(googleMirror) else google()
    mavenCentral()
    if (plugins) gradlePluginPortal()
}

pluginManagement {
    val mirror: String? = providers.gradleProperty("googleMaven").orNull
    val relay: String? = providers.gradleProperty("mavenRelay").orNull
    repositories {
        if (relay != null) {
            maven("$relay/google/") { isAllowInsecureProtocol = true }
            maven("$relay/central/") { isAllowInsecureProtocol = true }
            maven("$relay/plugins/") { isAllowInsecureProtocol = true }
        } else {
            if (mirror != null) maven(mirror) else google()
            mavenCentral()
            gradlePluginPortal()
        }
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        veilRepos(providers.gradleProperty("googleMaven").orNull, providers.gradleProperty("mavenRelay").orNull, plugins = false)
    }
}
rootProject.name = "VeilVpn"
include(":app")
