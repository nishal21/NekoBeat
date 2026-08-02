import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val gstRoot: String = System.getenv("GSTREAMER_ROOT_ANDROID")
    ?: (project.findProperty("gstAndroidRoot") as String?)
    // rootProject = gen/android → ../../../vendor = repo root vendor/
    ?: (rootProject.projectDir.resolve("../../../vendor").canonicalPath)

// SpotiFLAC Go AAR: packaged when CI sets NEKOBEAT_ENABLE_GOBACKEND=1 and AAR exists.
// Loaded only in process :spotiflac (SpotiFlacService) — never in main UI process.
val gobackendAarFile = file("libs/gobackend.aar")
val enableGobackend =
    System.getenv("NEKOBEAT_ENABLE_GOBACKEND") == "1" && gobackendAarFile.exists()

android {
    compileSdk = 36
    namespace = "com.nishal21.nekobeat"
    // Keep in sync with CI sdkmanager ndk;… (avoid CXX1104 vs ndk.dir)
    ndkVersion = "27.0.12077973"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.nishal21.nekobeat"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField("boolean", "HAS_GOBACKEND", if (enableGobackend) "true" else "false")
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
        externalNativeBuild {
            ndkBuild {
                arguments("GSTREAMER_ROOT_ANDROID=$gstRoot")
            }
        }
    }
    externalNativeBuild {
        ndkBuild {
            path = file("../../../android-gst/jni/Android.mk")
        }
    }
    sourceSets {
        getByName("main") {
            java.srcDirs("../../../android-gst/java")
            // Umbrella .so is installed under src/main/jniLibs by CI prebuild.
            // Do NOT add android-gst/libs as jniLibs — Duplicate resources.
        }
    }
    packaging {
        jniLibs {
            // Safety net if Tauri + ndk-build both emit the same .so
            pickFirsts += listOf(
                "**/libgstreamer_android.so",
                "**/libc++_shared.so",
            )
        }
    }
    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            val keystoreProperties = Properties()
            check(keystorePropertiesFile.exists()) {
                "Missing keystore.properties — run scripts/ci-android-signing.sh first."
            }
            keystoreProperties.load(FileInputStream(keystorePropertiesFile))
            keyAlias = keystoreProperties["keyAlias"] as String
            val pass = keystoreProperties["password"] as String
            keyPassword = (keystoreProperties["keyPassword"] as String?) ?: pass
            storePassword = pass
            // storeFile is relative to this app module directory
            storeFile = file(keystoreProperties["storeFile"] as String)
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // Sideload APKs: keep minify off until ProGuard keep rules are solid
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    // SpotiFLAC-Mobile go_backend — isolated in :spotiflac via SpotiFlacService.
    if (enableGobackend) {
        implementation(files(gobackendAarFile))
        logger.lifecycle("gobackend.aar packaged (HAS_GOBACKEND=true, process=:spotiflac)")
    } else if (gobackendAarFile.exists()) {
        logger.warn(
            "gobackend.aar present but NOT packaged — set NEKOBEAT_ENABLE_GOBACKEND=1 (loads in :spotiflac only)",
        )
    } else {
        logger.warn(
            "gobackend.aar missing at ${gobackendAarFile.path} — Android Spotify HiFi via AAR disabled",
        )
    }
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
