package com.techboydeepak.tbd_vault

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        registerClipboard(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger,
            "com.techboydeepak.tbd/pairing").setMethodCallHandler { call, result ->
            try {
                val store = PairingStore(this)
                when (call.method) {
                    "publish" -> {
                        val secret = call.argument<String>("secret") ?: error("Missing secret")
                        val period = call.argument<Int>("period") ?: error("Missing period")
                        store.publish(secret, period)
                        result.success(null)
                    }
                    "readPeriod" -> result.success(store.readPeriod())
                    "writePeriod" -> {
                        val period = call.argument<Int>("period") ?: error("Missing period")
                        store.writePeriod(period)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (error: Exception) {
                result.error("PAIRING_ERROR", error.message ?: "Pairing failed", null)
            }
        }
    }

    private fun registerClipboard(flutterEngine: FlutterEngine) {
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger,
            "com.techboydeepak.tbd/clipboard").setMethodCallHandler { call, result ->
            if (call.method != "copy") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            val text = call.argument<String>("text")
            if (text == null) {
                result.error("CLIPBOARD_ERROR", "Missing text", null)
                return@setMethodCallHandler
            }
            val clip = ClipData.newPlainText("TBD", text)
            if (Build.VERSION.SDK_INT >= 33) {
                clip.description.extras = PersistableBundle().apply {
                    putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                }
            }
            val manager = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            manager.setPrimaryClip(clip)
            result.success(null)
        }
    }
}
