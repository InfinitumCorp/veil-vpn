plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

import java.util.Properties

val controlUrl = (findProperty("veilControlUrl") as String?) ?: "http://10.0.2.2:8787"
// Cumulus ID sign-in. -PveilCidIssuer=https://... points the app at a mirror (e.g. one reachable from
// Russia without a VPN). The return page must be on an origin registered for the "veil-vpn" client.
val cidIssuer = ((findProperty("veilCidIssuer") as String?) ?: "https://id.cumuluscloud.app").trimEnd('/')
val cidReturnBase = (findProperty("veilCidReturn") as String?) ?: "https://infinitumveilvpn.app/app-signin/"

// AdMob. Both IDs are public (they ship inside the app). Until Infinitum's own IDs are passed with
// -PveilAdmobAppId=ca-app-pub-...~... -PveilAdmobBannerId=ca-app-pub-.../..., Google's sample IDs
// are used, which serve test ads only. A release build refuses the sample IDs.
val admobTestAppId = "ca-app-pub-3940256099942544~3347511713"
val admobTestBannerId = "ca-app-pub-3940256099942544/9214589741"
val admobAppId = (findProperty("veilAdmobAppId") as String?) ?: admobTestAppId
val admobBannerId = (findProperty("veilAdmobBannerId") as String?) ?: admobTestBannerId

// Release signing. Secrets never live in this file: they come from android/keystore.properties
// (kept out of version control) or, on a build server, from environment variables.
//   storeFile=keystore/veil-upload.jks  storePassword=...  keyAlias=veil-upload  keyPassword=...
//   VEIL_KEYSTORE, VEIL_KEYSTORE_PASSWORD, VEIL_KEY_ALIAS, VEIL_KEY_PASSWORD
val signing = Properties().apply {
    rootProject.file("keystore.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
    System.getenv("VEIL_KEYSTORE")?.let { setProperty("storeFile", it) }
    System.getenv("VEIL_KEYSTORE_PASSWORD")?.let { setProperty("storePassword", it) }
    System.getenv("VEIL_KEY_ALIAS")?.let { setProperty("keyAlias", it) }
    System.getenv("VEIL_KEY_PASSWORD")?.let { setProperty("keyPassword", it) }
}
val canSign = listOf("storeFile", "storePassword", "keyAlias", "keyPassword").all { !signing.getProperty(it).isNullOrBlank() }

android {
    namespace = "com.infinitum.veilvpn"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.infinitum.veilvpn"
        minSdk = 26
        targetSdk = 36
        versionCode = (findProperty("veilVersionCode") as String?)?.toInt() ?: 1
        versionName = (findProperty("veilVersionName") as String?) ?: "0.1.0"
        buildConfigField("String", "CONTROL_URL", "\"$controlUrl\"")
        buildConfigField("String", "CID_ISSUER", "\"$cidIssuer\"")
        buildConfigField("String", "ADMOB_BANNER_ID", "\"$admobBannerId\"")
        manifestPlaceholders["admobAppId"] = admobAppId
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        if (canSign) create("release") {
            storeFile = rootProject.file(signing.getProperty("storeFile"))
            storePassword = signing.getProperty("storePassword")
            keyAlias = signing.getProperty("keyAlias")
            keyPassword = signing.getProperty("keyPassword")
        }
    }

    buildTypes {
        // Debug builds install next to the release app (own package, own name).
        debug {
            applicationIdSuffix = ".debug"
            // Its own return link, so a debug build never catches the release app's sign-in.
            manifestPlaceholders["cidScheme"] = "veilvpn-debug"
            buildConfigField("String", "CID_SCHEME", "\"veilvpn-debug\"")
            buildConfigField("String", "CID_RETURN", "\"${cidReturnBase}?to=veilvpn-debug\"")
        }
        release {
            manifestPlaceholders["cidScheme"] = "veilvpn"
            buildConfigField("String", "CID_SCHEME", "\"veilvpn\"")
            buildConfigField("String", "CID_RETURN", "\"${cidReturnBase}?to=veilvpn\"")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (canSign) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
}

// A release build must talk to the control server over HTTPS and must be signed.
tasks.matching { it.name.matches(Regex("(assemble|bundle)Release")) }.configureEach {
    doFirst {
        check(controlUrl.startsWith("https://")) { "Release builds need -PveilControlUrl=https://... (got $controlUrl)" }
        check(canSign) { "Release builds need a signing key: see android/keystore.properties.example" }
        check(admobAppId != admobTestAppId && admobBannerId != admobTestBannerId) { "Release builds need Infinitum's AdMob IDs: -PveilAdmobAppId=... -PveilAdmobBannerId=..." }
    }
}

dependencies {
    implementation("com.wireguard.android:tunnel:1.0.20230706")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.browser:browser:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.google.android.gms:play-services-ads:24.4.0")
    implementation("com.google.android.ump:user-messaging-platform:3.2.0")
}
