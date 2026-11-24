# BarberPro Android build and Play Store release

The native Android project is in `android/`. It wraps the responsive BarberPro workspace in a native Android WebView and keeps authentication/session storage on the device. It requires Android Studio/SDK 35, JDK 17 and Gradle 8.9.

## Configure the production URL

Before building a release, replace the placeholder `BARBERPRO_BASE_URL` in `android/app/build.gradle` with the verified HTTPS production domain. Do not ship the placeholder URL.

## Build

```sh
gradle -p android assembleDebug
gradle -p android bundleRelease
```

A release bundle must be signed using a private upload key. Keep the keystore and passwords outside GitHub and inject them through protected CI secrets. The debug APK is not suitable for Play Store distribution.

## Google Play submission

A Play Console developer account, verified app identity, signed Android App Bundle, privacy policy URL, Data safety declarations, content rating, screenshots, store listing, target SDK compliance and release approval are required. This repository does not have access to the user's Play Console and cannot publish or approve a release. The Android CI build only verifies that the project assembles.
