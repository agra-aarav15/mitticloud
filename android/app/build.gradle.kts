plugins {
    alias(libs.plugins.android.application)
}

val mittiVersion = (rootProject.file("../package.json").readText()
    .let { Regex("\"version\"\s*:\s*\"([^\"]+)\"").find(it)?.groupValues?.get(1) } ?: "0.0.0")

android {
    namespace = "in.mitticloud.app"
    compileSdk = 36

    defaultConfig {
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
        applicationId = "in.mitticloud.app"
        minSdk = 24
        targetSdk = 36
        versionCode = 16
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
