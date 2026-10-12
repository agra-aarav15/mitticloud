plugins {
    alias(libs.plugins.android.application)
}

val mittiVersion = (rootProject.file("../package.json").readText()
    .let { Regex("[\"]version[\"][ ]*:[ ]*[\"]([^\"]+)[\"]").find(it)?.groupValues?.get(1) } ?: "0.0.0")

// versionCode must rise for every upload, and was frozen at 20 across v0.16-v0.17.9.
// Derive it from the version so it can never be forgotten again: 0.17.23 -> 1721.
// Play caps this at 2100000000; major*10000 stays well inside that.
val mittiVersionCode = mittiVersion.split('.').let { parts ->
    val major = parts.getOrNull(0)?.toIntOrNull() ?: 0
    val minor = parts.getOrNull(1)?.toIntOrNull() ?: 0
    val patch = parts.getOrNull(2)?.toIntOrNull() ?: 0
    major * 10000 + minor * 100 + patch
}

android {
    namespace = "in.mitticloud.app"
    compileSdk = 36
    ndkVersion = "27.0.12077973"

    defaultConfig {
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
        applicationId = "in.mitticloud.app"
        minSdk = 24
        targetSdk = 36
        versionCode = mittiVersionCode
        versionName = mittiVersion
    }

    signingConfigs {
        create("release") {
            val ks = System.getenv("MITTI_KEYSTORE") ?: ""
            if (ks.isNotEmpty()) {
                storeFile = file(ks)
                storePassword = System.getenv("MITTI_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("MITTI_KEY_ALIAS") ?: "mitticloud"
                keyPassword = System.getenv("MITTI_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (System.getenv("MITTI_KEYSTORE").isNullOrEmpty()) null else signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.18.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
