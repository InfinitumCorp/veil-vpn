plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

import java.util.Properties

val controlUrl = (findProperty("veilControlUrl") as String?) ?: "http://10.0.2.2:8787"

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
        }
        release {
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
    }
}

dependencies {
    implementation("com.amplitude:analytics-android:1.37.1")
    implementation("com.wireguard.android:tunnel:1.0.20230706")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}
