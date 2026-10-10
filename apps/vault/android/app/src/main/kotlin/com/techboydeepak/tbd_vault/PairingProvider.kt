package com.techboydeepak.tbd_vault

import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process

class PairingProvider : ContentProvider() {
    override fun onCreate() = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        val app = context ?: error("Provider unavailable")
        val caller = Binder.getCallingUid()
        if (caller != Process.myUid() &&
            app.packageManager.checkSignatures(Process.myUid(), caller) !=
            PackageManager.SIGNATURE_MATCH) {
            throw SecurityException("Only the matching TBD Codes app can pair")
        }
        val store = PairingStore(app)
        return when (method) {
            "consume" -> store.consume()?.let {
                Bundle().apply {
                    putString("secret", it.first)
                    putInt("period", it.second)
                }
            }
            "readPeriod" -> Bundle().apply {
                store.readPeriod()?.let { putInt("period", it) }
            }
            "writePeriod" -> {
                val period = extras?.getInt("period") ?: error("Missing period")
                store.writePeriod(period)
                Bundle()
            }
            else -> throw IllegalArgumentException("Unsupported pairing method")
        }
    }

    override fun query(uri: Uri, projection: Array<out String>?,
        selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?,
        selectionArgs: Array<out String>?): Int = 0
}
