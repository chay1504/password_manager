package com.techboydeepak.tbd_vault

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

class PairingStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("private_pairing", Context.MODE_PRIVATE)
    private val alias = "tbd_pending_pairing"

    @Synchronized
    fun publish(secret: String, period: Int) {
        require(period in 5..10)
        require(Base64.decode(secret, Base64.NO_WRAP).size == 32)
        val payload = JSONObject()
            .put("secret", secret)
            .put("period", period)
            .put("createdAt", System.currentTimeMillis())
            .toString()
            .toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val encrypted = Base64.encodeToString(cipher.doFinal(payload), Base64.NO_WRAP)
        check(prefs.edit().putString("pending", "$iv:$encrypted")
            .putInt("period", period).commit())
    }

    @Synchronized
    fun consume(): Pair<String, Int>? {
        val raw = prefs.getString("pending", null) ?: return null
        prefs.edit().remove("pending").commit()
        val parts = raw.split(":", limit = 2)
        if (parts.size != 2) return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        val payload = JSONObject(String(cipher.doFinal(
            Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8))
        val age = System.currentTimeMillis() - payload.getLong("createdAt")
        if (age < 0 || age > 5 * 60 * 1000) return null
        val secret = payload.getString("secret")
        val period = payload.getInt("period")
        if (period !in 5..10 || Base64.decode(secret, Base64.NO_WRAP).size != 32) return null
        return Pair(secret, period)
    }

    fun readPeriod(): Int? {
        val period = prefs.getInt("period", 0)
        return if (period in 5..10) period else null
    }

    fun writePeriod(period: Int) {
        require(period in 5..10)
        check(prefs.edit().putInt("period", period).commit())
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore")
        keyStore.load(null)
        val existing = keyStore.getKey(alias, null)
        if (existing is SecretKey) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build())
        return generator.generateKey()
    }
}
