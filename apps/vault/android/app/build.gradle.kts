plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val privateKeystore = System.getenv("TBD_ANDROID_KEYSTORE")
val privateStorePassword = System.getenv("TBD_ANDROID_STORE_PASSWORD")
val privateKeyAlias = System.getenv("TBD_ANDROID_KEY_ALIAS")
val privateKeyPassword = System.getenv("TBD_ANDROID_KEY_PASSWORD")

android {
    namespace = "com.techboydeepak.tbd_vault"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.techboydeepak.tbd_vault"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 30
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("privateRelease") {
            if (privateKeystore != null && privateStorePassword != null &&
                privateKeyAlias != null && privateKeyPassword != null) {
                storeFile = file(privateKeystore)
                storePassword = privateStorePassword
                keyAlias = privateKeyAlias
                keyPassword = privateKeyPassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("privateRelease")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
