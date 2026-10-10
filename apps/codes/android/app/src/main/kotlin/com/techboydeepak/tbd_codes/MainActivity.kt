package com.techboydeepak.tbd_codes

import android.net.Uri
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
    private val uri = Uri.parse("content://com.techboydeepak.tbd_vault.pairing")

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
                when (call.method) {
                    "consume" -> {
                        val bundle = contentResolver.call(uri, "consume", null, null)
                        result.success(bundle?.let { mapOf(
                            "secret" to it.getString("secret"),
                            "period" to it.getInt("period")) })
                    }
                    "readPeriod" -> {
                        val bundle = contentResolver.call(uri, "readPeriod", null, null)
                        result.success(if (bundle?.containsKey("period") == true)
                            bundle.getInt("period") else null)
                    }
                    "writePeriod" -> {
                        val period = call.argument<Int>("period") ?: error("Missing period")
                        contentResolver.call(uri, "writePeriod", null,
                            Bundle().apply { putInt("period", period) })
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
