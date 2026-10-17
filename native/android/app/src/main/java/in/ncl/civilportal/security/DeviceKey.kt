package `in`.ncl.civilportal.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * The phone's credential (decision 13): an EC P-256 key made inside the
 * Android Keystore, in the StrongBox secure chip where the phone has one.
 * The private key is never exported; the app only asks the Keystore to
 * sign the server's one-time challenge with it. The server holds the
 * public key, recorded when the phone was registered.
 */
class DeviceKey(private val alias: String = "ncl-civilportal-device") {
    private val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    val exists: Boolean get() = ks.containsAlias(alias)

    /** Make the key if this installation has none yet. */
    fun ensure() {
        if (exists) return
        try { generate(strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) }
        catch (e: StrongBoxUnavailableException) { generate(strongBox = false) }
    }

    private fun generate(strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
            initialize(spec); generateKeyPair()
        }
    }

    /** The public key as the server stores it. */
    fun publicKeyPem(): String = Ecdsa.publicKeyPem(ks.getCertificate(alias).publicKey.encoded)

    /** Sign the server's nonce: SHA-256 with ECDSA, sent as base64 of r‖s. */
    fun sign(nonce: String): String {
        val key = ks.getKey(alias, null) as PrivateKey
        val der = Signature.getInstance("SHA256withECDSA").run {
            initSign(key); update(nonce.toByteArray(Charsets.UTF_8)); sign()
        }
        return Base64.getEncoder().encodeToString(Ecdsa.derToP1363(der))
    }

    /** Forget this phone (the registration must then be done again). */
    fun delete() { if (exists) ks.deleteEntry(alias) }
}
